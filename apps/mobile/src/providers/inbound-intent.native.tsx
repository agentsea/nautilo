/**
 * D468 — the single root owner for inbound URLs and notification responses.
 *
 * A push envelope is only a hint. This provider delegates parsing and the
 * server-bound headless verification to `inbound-intent.ts`, then makes a
 * visible server selection only after that work has succeeded. Nothing from a
 * push payload is persisted or used as a server URL/credential.
 */
import { NautiloApiClient } from "@nautilo/api-client/browser";
import * as Device from "expo-device";
import { File, Paths } from "expo-file-system";
import * as Linking from "expo-linking";
import * as Notifications from "expo-notifications";
import { router, useGlobalSearchParams, usePathname } from "expo-router";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState, Platform, Pressable, StyleSheet, Text, View } from "react-native";

import {
  acceptRemotePairingInput,
  REMOTE_PAIRING_ROUTE,
} from "@/features/remote/computer-pairing-handoff";
import { getInviteIntake } from "@/features/invite-redemption/invite-intake";
import { ensureValidToken } from "@/lib/auth";
import { parseDeepLink } from "@/lib/deep-link";
import {
  consumeStack309IosSimulatorInvite,
  stack309IosSimulatorHarnessEnabled,
  STACK309_IOS_SIMULATOR_STAGED_INVITE,
} from "@/lib/stack309-ios-simulator-invite";
import {
  createInboundIntentCoordinator,
  createOneShotPushHandoff,
  createPushIntentResolver,
  parseMobilePushNotification,
  shouldSuppressForegroundPush,
  shouldPresentForegroundPush,
  type ImportantMessageEnvelope,
  type InboundUrlIntent,
  type MobilePushIntentResolution,
} from "@/lib/inbound-intent";
import { loadPushBinding } from "@/lib/push-binding-store";
import {
  claimPendingShare,
  clearPendingShareForScope,
  savePendingShare,
  type PendingShareScope,
} from "@/lib/pending-share";
import {
  claimInboundShareReceipt,
  clearInboundShareReceiptForScope,
  saveInboundShareReceipt,
  stageNativeInboundFileReceipt,
} from "@/lib/inbound-share-custody";
import { getNativeInboundShareStore } from "@/lib/inbound-share-file";
import { stageNativeSharedTextIntent } from "@/lib/share-handoff";
import {
  loadRegistry,
  loadServerRegistrationSnapshot,
} from "@/lib/server-store";
import { useAuth } from "@/providers/auth";
import { useRealtime } from "@/providers/realtime";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import { resumeShareReview } from "@/features/share/share-review-recovery";
import type { MobilePushEnvelopeV1 } from "@nautilo/types";

type ImportantEnvelope = ImportantMessageEnvelope;

type InboundNotice = {
  readonly message: string;
  readonly id: number;
} | null;

interface InboundIntentValue {
  readonly notice: InboundNotice;
  dismissNotice(): void;
}

const InboundIntentContext = createContext<InboundIntentValue | null>(null);

// One root policy: when Nautilo is already foregrounded, suppress the native
// banner. The coordinator below gives a bounded in-app indication only when
// the exact target conversation is not already open.
const QUIET_FOREGROUND_PRESENTATION = {
  shouldShowBanner: false,
  shouldShowList: false,
  shouldPlaySound: false,
  shouldSetBadge: false,
};

const TEST_FOREGROUND_PRESENTATION: typeof QUIET_FOREGROUND_PRESENTATION = {
  shouldShowBanner: true,
  shouldShowList: true,
  shouldPlaySound: true,
  shouldSetBadge: false,
};

let foregroundPresentationHandler: ((notification: unknown) => Promise<typeof QUIET_FOREGROUND_PRESENTATION>) | null = null;

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    try {
      return await (foregroundPresentationHandler?.(notification) ?? Promise.resolve(QUIET_FOREGROUND_PRESENTATION));
    } catch {
      return QUIET_FOREGROUND_PRESENTATION;
    }
  },
});

function isImportant(envelope: MobilePushEnvelopeV1): envelope is ImportantEnvelope {
  return envelope.kind === "important_message";
}

function currentOpenRoom(pathname: string, params: Record<string, string | string[] | undefined>): string | null {
  if (!pathname.startsWith("/chat/")) return null;
  const roomId = params.roomId;
  return typeof roomId === "string" ? roomId : null;
}

class ShareScopeChangedError extends Error {}

function sameShareScope(left: PendingShareScope | null, right: PendingShareScope | null): boolean {
  return left?.serverId === right?.serverId && left?.viewerId === right?.viewerId;
}

function outcomeMessage(outcome: Exclude<MobilePushIntentResolution, { readonly kind: "navigate" | "current_room" }>): string {
  switch (outcome.kind) {
    case "test_acknowledged":
      return "Test notification received.";
    case "needs_you_unavailable":
      return "This notification type is not available on Mobile yet.";
    case "unknown_binding":
      return "This notification belongs to a server that is no longer connected.";
    case "signed_out":
      return "Sign in to continue to this conversation.";
    case "offline":
      return "Nautilo is offline. We’ll retry once when it reconnects.";
    case "unavailable":
      return "Nautilo is temporarily unavailable. Try again shortly.";
    case "denied":
      return "You no longer have access to this conversation.";
    case "deleted":
      return "This conversation or message is no longer available.";
  }
}

export function InboundIntentProvider({ children }: { readonly children: ReactNode }) {
  const { activeServer, switchTo } = useServers();
  const { status, viewer, viewerState } = useAuth();
  const { openRevision } = useRealtime();
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  const openRoomId = currentOpenRoom(pathname, params);
  const [notice, setNotice] = useState<InboundNotice>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interactionGenerationRef = useRef(0);
  const handoffRef = useRef(createOneShotPushHandoff());
  const activeServerRef = useRef(activeServer);
  const openRoomIdRef = useRef(openRoomId);
  activeServerRef.current = activeServer;
  openRoomIdRef.current = openRoomId;

  const showNotice = useCallback((message: string) => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    const id = Date.now();
    setNotice({ message, id });
    noticeTimerRef.current = setTimeout(() => {
      setNotice((current) => current?.id === id ? null : current);
      noticeTimerRef.current = null;
    }, 5_000);
  }, []);

  const dismissNotice = useCallback(() => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = null;
    setNotice(null);
  }, []);

  useEffect(() => () => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
  }, []);

  const resolverRef = useRef<ReturnType<typeof createPushIntentResolver> | null>(null);
  if (!resolverRef.current) {
    resolverRef.current = createPushIntentResolver({
      loadRegistry,
      loadBinding: loadPushBinding,
      loadServerRegistrationSnapshot,
      isServerRegistrationCurrent: async (snapshot) => {
        const current = await loadServerRegistrationSnapshot(snapshot.server.id);
        return current !== null
          && current.server.serverUrl === snapshot.server.serverUrl
          && current.lifecycleRevision === snapshot.lifecycleRevision;
      },
      ensureValidToken,
      createClient: (serverUrl) => new NautiloApiClient(serverUrl),
    });
  }

  const selectTarget = useCallback(async (
    serverId: string,
    serverUrl: string,
    lifecycleRevision: number,
  ): Promise<boolean> => {
    try {
      const before = await loadServerRegistrationSnapshot(serverId);
      if (
        !before
        || before.server.serverUrl !== serverUrl
        || before.lifecycleRevision !== lifecycleRevision
      ) return false;
      const generation = ++interactionGenerationRef.current;
      await switchTo(serverId);
      const after = await loadServerRegistrationSnapshot(serverId);
      const registry = await loadRegistry();
      return interactionGenerationRef.current === generation
        && after !== null
        && after.server.serverUrl === serverUrl
        && after.lifecycleRevision === lifecycleRevision
        && registry.activeId === serverId;
    } catch {
      return false;
    }
  }, [switchTo]);

  const consumeOutcome = useCallback(async (
    envelope: MobilePushEnvelopeV1,
    outcome: MobilePushIntentResolution,
    resume: false | "signed_out" | "offline" = false,
  ): Promise<void> => {
    if (outcome.kind === "navigate") {
      if (!await selectTarget(
        outcome.target.serverId,
        outcome.target.serverUrl,
        outcome.target.lifecycleRevision,
      )) {
        showNotice("This server is no longer connected.");
        return;
      }
      router.push({
        pathname: "/chat/[roomId]",
        params: { roomId: outcome.target.roomId, targetMessageId: outcome.target.messageId },
      });
      return;
    }
    if (outcome.kind === "current_room") {
      if (!await selectTarget(
        outcome.target.serverId,
        outcome.target.serverUrl,
        outcome.target.lifecycleRevision,
      )) {
        showNotice("This server is no longer connected.");
        return;
      }
      router.push({ pathname: "/chat/[roomId]", params: { roomId: outcome.target.roomId } });
      showNotice("The earlier message is no longer available. Opened the conversation.");
      return;
    }

    if (outcome.kind === "signed_out" && isImportant(envelope)) {
      if (resume === "signed_out") {
        showNotice("Sign in completed, but this conversation is not available.");
        return;
      }
      handoffRef.current.replace({ envelope, serverId: outcome.target.serverId, reason: "signed_out" });
      if (!await selectTarget(
        outcome.target.serverId,
        outcome.target.serverUrl,
        outcome.target.lifecycleRevision,
      )) {
        handoffRef.current.clear();
        showNotice("This server is no longer connected.");
        return;
      }
      router.replace("/(onboarding)/sign-in");
      showNotice(outcomeMessage(outcome));
      return;
    }

    if (outcome.kind === "offline" && isImportant(envelope)) {
      if (resume === "offline") {
        showNotice("Nautilo is still offline. Try again when it reconnects.");
        return;
      }
      handoffRef.current.replace({ envelope, serverId: outcome.target.serverId, reason: "offline" });
      if (!await selectTarget(
        outcome.target.serverId,
        outcome.target.serverUrl,
        outcome.target.lifecycleRevision,
      )) {
        handoffRef.current.clear();
        showNotice("This server is no longer connected.");
        return;
      }
      showNotice(outcomeMessage(outcome));
      return;
    }

    showNotice(outcomeMessage(outcome));
  }, [selectTarget, showNotice]);

  const consumePush = useCallback(async (
    envelope: MobilePushEnvelopeV1,
    resume: false | "signed_out" | "offline" = false,
  ) => {
    const outcome = await resolverRef.current!.resolve(envelope);
    await consumeOutcome(envelope, outcome, resume);
  }, [consumeOutcome]);
  const consumePushRef = useRef(consumePush);
  consumePushRef.current = consumePush;

  // A sign-in/resume is deliberately one-shot. We do not retain notification
  // payloads across a restart or keep redirecting after the user chose another
  // server.
  useEffect(() => {
    if (status !== "signed-in" || !activeServer) return;
    const envelope = handoffRef.current.takeForSignedIn(activeServer.id);
    if (envelope) void consumePush(envelope, "signed_out").catch(() => showNotice("Nautilo is temporarily unavailable."));
  }, [activeServer, consumePush, showNotice, status]);

  useEffect(() => {
    if (openRevision === 0 || !activeServer) return;
    const envelope = handoffRef.current.takeForReconnect(activeServer.id);
    if (envelope) void consumePush(envelope, "offline").catch(() => showNotice("Nautilo is temporarily unavailable."));
  }, [activeServer, openRevision, consumePush, showNotice]);

  const onUrlIntent = useCallback(async (intent: Exclude<InboundUrlIntent, { readonly kind: "callback" | "unknown" }>) => {
    switch (intent.kind) {
      case "add-server":
        router.push({ pathname: "/(onboarding)/add-server", params: { url: intent.url } });
        return;
      case "invite":
        // InviteIntake is the sole bearer-custody boundary. Navigation gets
        // only exact-server correlation values after SecureStore accepts it.
        {
          const result = await getInviteIntake().acceptParsed(intent, "deep-link", (route) => router.push(route));
          if (result.kind === "persistence-failed") {
            router.push({ pathname: "/(onboarding)/invite", params: { error: "persistence-failed" } });
          }
        }
        return;
      case "invalid-invite":
        router.push({ pathname: "/(onboarding)/invite", params: { error: "invalid-link" } });
        return;
      case "remote-pair":
        acceptRemotePairingInput(intent, (route: typeof REMOTE_PAIRING_ROUTE) => router.push(route));
        return;
    }
  }, []);

  // Stack 309 local acceptance only: production and physical iOS devices
  // cannot enter this path. A protected host harness stages the locator in the
  // Simulator app container, then this callback runs the ordinary custody
  // boundary before navigation. No bearer is rendered, logged, or routed.
  const stack309IosSimulatorConsumedRef = useRef(false);
  useEffect(() => {
    if (!stack309IosSimulatorHarnessEnabled({
      isDevelopment: __DEV__,
      platform: Platform.OS,
      isPhysicalDevice: Device.isDevice,
    }) || stack309IosSimulatorConsumedRef.current) return;
    // Give the real root auth gate one pass to settle its server-less
    // onboarding route. Otherwise the development-only fixture can persist a
    // perfectly valid handoff while its route is immediately replaced by the
    // root's cold-start redirect.
    const timer = setTimeout(() => {
      stack309IosSimulatorConsumedRef.current = true;
      const file = new File(Paths.document, STACK309_IOS_SIMULATOR_STAGED_INVITE);
      void consumeStack309IosSimulatorInvite(file, (rawLocator) =>
        getInviteIntake().acceptRaw(rawLocator, "deep-link", (route) => router.push(route)),
      );
    }, 750);
    return () => clearTimeout(timer);
  }, []);

  const onForegroundPush = useCallback(async (envelope: MobilePushEnvelopeV1) => {
    if (envelope.kind === "test") {
      showNotice("Test notification received on this phone.");
      return;
    }
    if (!isImportant(envelope)) return;
    const bindingServer = await resolverRef.current!.findBindingServer(envelope.bindingId);
    if (shouldSuppressForegroundPush(envelope, {
      bindingServerId: bindingServer?.id ?? null,
      activeServerId: activeServerRef.current?.id ?? null,
      openRoomId: openRoomIdRef.current,
    })) return;
    showNotice("New important message.");
  }, [showNotice]);

  const coordinatorRef = useRef<ReturnType<typeof createInboundIntentCoordinator> | null>(null);
  useEffect(() => {
    const coordinator = createInboundIntentCoordinator({
      parseUrl: parseDeepLink,
      linking: {
        getInitialUrl: () => Linking.getInitialURL(),
        addUrlListener: (listener) => {
          const subscription = Linking.addEventListener("url", ({ url }) => listener(url));
          return () => subscription.remove();
        },
      },
      notifications: {
        getLastResponse: () => Notifications.getLastNotificationResponse(),
        addResponseListener: (listener) => {
          const subscription = Notifications.addNotificationResponseReceivedListener(listener);
          return () => subscription.remove();
        },
        addReceivedListener: (listener) => {
          const subscription = Notifications.addNotificationReceivedListener(listener);
          return () => subscription.remove();
        },
      },
      onUrlIntent,
      onPushResponse: (envelope) => consumePushRef.current(envelope),
      onForegroundPush,
    });
    coordinatorRef.current = coordinator;
    coordinator.start();
    return () => {
      coordinator.stop();
      if (coordinatorRef.current === coordinator) coordinatorRef.current = null;
    };
  }, [onForegroundPush, onUrlIntent]);

  // Native custody is moved into device-only encrypted staging before auth.
  // This prevents an OAuth callback from replacing Android's ACTION_SEND
  // intent and prevents a crash between native read and durable custody from
  // losing the item. Server and Room are chosen only after verified sign-in.
  const shareConsumeInFlightRef = useRef(false);
  const lastShareScopeRef = useRef<PendingShareScope | null>(null);
  const currentShareScope = useMemo<PendingShareScope | null>(
    () => status === "signed-in" && viewerState === "verified" && viewer && activeServer
      ? { serverId: activeServer.id, viewerId: viewer.userId }
      : null,
    [activeServer, status, viewer, viewerState],
  );
  const currentShareScopeRef = useRef(currentShareScope);
  // This is deliberately assigned during render: native intake can await
  // while auth/server state changes, and must check the newest scope before
  // committing any bound receipt.
  currentShareScopeRef.current = currentShareScope;
  const openPendingShare = useCallback(async () => {
    if (!currentShareScope || pathname === "/share") return;
    const [text, file] = await Promise.all([
      claimPendingShare(currentShareScope),
      claimInboundShareReceipt(currentShareScope),
    ]);
    if (text || file) router.push("/share");
  }, [currentShareScope, pathname]);
  const stageNativeShare = useCallback(async (): Promise<boolean> => {
    if (shareConsumeInFlightRef.current) return false;
    shareConsumeInFlightRef.current = true;
    try {
      const intakeScope = currentShareScope;
      const text = await stageNativeSharedTextIntent((intent) => {
        if (intakeScope && !sameShareScope(intakeScope, currentShareScopeRef.current)) {
          // Do not acknowledge native custody: a later lifecycle tick may
          // safely restage it for the current authenticated identity.
          throw new ShareScopeChangedError();
        }
        return savePendingShare(intent, undefined, undefined, intakeScope);
      });
      const nativeFile = await getNativeInboundShareStore();
      const file = nativeFile
        ? await stageNativeInboundFileReceipt((receipt) => {
          if (intakeScope && !sameShareScope(intakeScope, currentShareScopeRef.current)) {
            throw new ShareScopeChangedError();
          }
          return saveInboundShareReceipt(receipt, intakeScope);
        }, Date.now(), nativeFile)
        : null;
      return text !== null || file !== null;
    } catch (error) {
      if (error instanceof ShareScopeChangedError) return false;
      showNotice("Could not open the shared item. Try sharing it again.");
      return false;
    } finally {
      shareConsumeInFlightRef.current = false;
    }
  }, [currentShareScope, showNotice]);

  useEffect(() => {
    // Always check durable custody after native staging. After process death
    // the native receipt has already been acknowledged, so staging correctly
    // returns false while the exact server/viewer-bound review still exists.
    void resumeShareReview(stageNativeShare, openPendingShare);
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void resumeShareReview(stageNativeShare, openPendingShare);
    });
    return () => subscription.remove();
  }, [openPendingShare, stageNativeShare]);

  // A native receipt may survive the OAuth handoff unclaimed, but an item that
  // has been bound to a server/viewer must never survive logout or an identity
  // / server change. The file-receipt boundary follows the exact same rule.
  useEffect(() => {
    const prior = lastShareScopeRef.current;
    const changed = prior && (!currentShareScope
      || prior.serverId !== currentShareScope.serverId
      || prior.viewerId !== currentShareScope.viewerId);
    if (changed) {
      void Promise.all([
        clearPendingShareForScope(prior),
        clearInboundShareReceiptForScope(prior),
      ]).catch(() => {});
    }
    lastShareScopeRef.current = currentShareScope;
  }, [currentShareScope]);

  // Expo foreground policy needs current route/server state without adding a
  // second notification listener. The ordinary received listener above owns
  // the in-app notice and dedupe; this handler only quiets native UI.
  useEffect(() => {
    foregroundPresentationHandler = (notification) => {
      const envelope = parseMobilePushNotification(notification);
      return Promise.resolve(
        envelope && shouldPresentForegroundPush(envelope)
          ? TEST_FOREGROUND_PRESENTATION
          : QUIET_FOREGROUND_PRESENTATION,
      );
    };
    return () => { foregroundPresentationHandler = null; };
  }, []);

  const value = useMemo<InboundIntentValue>(() => ({ notice, dismissNotice }), [dismissNotice, notice]);
  return <InboundIntentContext.Provider value={value}>{children}</InboundIntentContext.Provider>;
}

export function InboundIntentNotice() {
  const context = useContext(InboundIntentContext);
  const t = useAppTheme();
  if (!context?.notice) return null;
  return (
    <View
      accessibilityRole="alert"
      style={[styles.notice, { backgroundColor: t.color.surface.subtle, borderColor: t.color.status.warning }]}
    >
      <Text style={[styles.noticeText, { color: t.color.text.foreground }]}>{context.notice.message}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss notification"
        onPress={() => context.dismissNotice()}
      >
        <Text style={[styles.dismiss, { color: t.color.status.warning }]}>Dismiss</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  notice: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    borderBottomWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  noticeText: { flex: 1, fontSize: 14, fontWeight: "600" },
  dismiss: { fontSize: 14, fontWeight: "700" },
});
