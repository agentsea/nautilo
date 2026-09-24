import { DarkTheme, DefaultTheme, router, Stack, ThemeProvider, usePathname, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { ActivityIndicator, useColorScheme, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AttentionBar } from "@/components/attention-bar";
import { CryptoDeviceAdmissionBoundary } from "@/components/crypto-device-admission-boundary";
import { DisconnectBanner } from "@/components/disconnect-banner";
import { PinModal } from "@/components/pin-modal";
import { RemoteHostsProvider } from "@/features/remote/remote-hosts";
import { isExactTaskId } from "@/features/task-work/task-detail-state";
import { rootTaskAttentionPlacement } from "@/features/task-work/task-attention-placement";
import { mobileUserAgreementDestination } from "@/features/user-agreement/admission";
import { roomIdFromLaneKey } from "@/lib/messages";
import { observeMobileTouchStart } from "@/lib/human-activity";
import { authGateNavigationTarget } from "@/lib/auth-gate-navigation";
import { authGateDestination } from "@/lib/session-expiry";
import { AttentionProvider, useAttention } from "@/providers/attention";
import { ArtifactEventsProvider } from "@/providers/artifact-events";
import { AutoApproveProvider } from "@/providers/auto-approve";
import { AuthProvider, useAuth } from "@/providers/auth";
import { InboundIntentNotice, InboundIntentProvider } from "@/providers/inbound-intent";
import { NotificationStateProvider } from "@/providers/notification-state";
import { PlatformCapabilitiesProvider, usePlatformRouteAdmission } from "@/providers/platform-capabilities";
import { PushLifecycleBridge } from "@/providers/push-lifecycle-bridge";
import { PushLifecycleProvider } from "@/providers/push-lifecycle";
import { RealtimeProvider } from "@/providers/realtime";
import { ServerRegistryProvider, useServers } from "@/providers/server-registry";
import { AppThemeProvider, useAppTheme } from "@/providers/theme";
import { UserAgreementProvider, useUserAgreement } from "@/providers/user-agreement";
import { VoiceProvider } from "@/providers/voice";

// Root layout owns shared providers, inbound navigation, and global overlays.
// Provider nesting, inside-out:
// ServerRegistry → PushLifecycle → Auth → ArtifactEvents → Realtime →
// InboundIntent → Voice → AutoApprove → Attention → Theme/Stack.
function AttentionOverlay() {
  const pathname = usePathname();
  const {
    attentionApproval,
    attentionHostChoice,
    capabilityError,
    dismissCapabilityError,
  } = useAttention();
  if (capabilityError) {
    return (
      <AttentionBar
        message={capabilityError}
        onPress={dismissCapabilityError}
        accessibilityHint="Dismisses this message"
      />
    );
  }
  if (attentionHostChoice) {
    const room = roomIdFromLaneKey(attentionHostChoice.laneKey);
    return (
      <AttentionBar
        message="Choose a computer to continue this request"
        onPress={() => {
          if (room) router.push(`/chat/${room}`);
        }}
      />
    );
  }
  if (!attentionApproval) return null;
  const isTaskApproval = attentionApproval.origin === "task";
  if (isTaskApproval && rootTaskAttentionPlacement(pathname) === "hidden") return null;
  const room = roomIdFromLaneKey(attentionApproval.laneKey);
  const message =
    attentionApproval.origin === "task"
      ? "Approval needed — tap to review"
      : `Approval needed in another conversation: ${attentionApproval.reason}`;
  // Task approvals are discoverable from the global authority as well as the
  // strip/detail. Only an exact Task identifier may become a route target.
  const onPress = () => {
    if (attentionApproval.origin === "task" && isExactTaskId(attentionApproval.taskId)) {
      router.push(`/tasks/${attentionApproval.taskId}`);
      return;
    }
    if (room) router.push(`/chat/${room}`);
  };
  return <AttentionBar message={message} onPress={onPress} compact={isTaskApproval} />;
}

// one canonical auth gate for every protected route. Wait for
// both providers to hydrate, then derive the destination from current state;
// do not depend on having observed a prior signed-in → signed-out transition.
function useAuthGate() {
  const { status } = useAuth();
  const { activeServer, loading: serversLoading } = useServers();
  const segments = useSegments();

  return {
    loading: serversLoading || status === "loading",
    destination: authGateDestination({
      serversLoading,
      authStatus: status,
      hasActiveServer: activeServer !== null,
      rootSegment: segments[0],
    }),
  };
}

function SessionLoadingBoundary() {
  const t = useAppTheme();
  return (
    <View
      accessibilityLabel="Starting Nautilo"
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: t.color.surface.background,
      }}
    >
      <ActivityIndicator size="large" color={t.color.brand.accent} />
    </View>
  );
}

function RootShell() {
  const authGate = useAuthGate();
  const { status: authStatus } = useAuth();
  const agreement = useUserAgreement();
  const pathname = usePathname();
  const segments = useSegments();
  const routeAdmission = usePlatformRouteAdmission(pathname);
  const agreementDestination = mobileUserAgreementDestination({
    authStatus,
    agreementStatus: agreement.status,
    rootSegment: segments[0],
    pathname,
  });
  useEffect(() => {
    if (!routeAdmission.allowed) {
      router.replace("/");
    } else if (authGate.destination) {
      router.replace(authGateNavigationTarget(authGate.destination));
    } else if (agreementDestination) {
      router.replace(agreementDestination);
    }
  }, [agreementDestination, authGate.destination, routeAdmission]);
  // Match the settled native-app shell pattern used by Buzz: while persisted
  // auth is unresolved, mount one neutral startup surface—not protected
  // feature trees full of independent spinners and stale cached content.
  // Keep the root navigator mounted while a redirect is pending. Returning a
  // bare Redirect here unmounted this layout on Android, restarted provider
  // hydration, and produced an endless loading → signed-out → remount loop.
  const navigatingToAuth = authGate.destination !== null || !routeAdmission.allowed || agreementDestination !== null;
  const agreementLoading = authStatus === "signed-in" && agreement.status === "loading";
  const productAvailable = authStatus === "signed-in" && agreement.status === "accepted";
  return (
    <View style={{ flex: 1 }}>
      {!authGate.loading && !navigatingToAuth && productAvailable ? <DisconnectBanner /> : null}
      {!authGate.loading && !navigatingToAuth && productAvailable ? <InboundIntentNotice /> : null}
      {!authGate.loading && !navigatingToAuth && productAvailable ? <AttentionOverlay /> : null}
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(drawer)" />
        <Stack.Screen name="(onboarding)" />
        <Stack.Screen name="agreement" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="chat" options={{ headerShown: false }} />
        <Stack.Screen name="tasks" options={{ headerShown: false }} />
        <Stack.Screen name="share" options={{ headerShown: false, presentation: "modal", gestureEnabled: false }} />
        {/* OAuth redirect target (nautilo://callback). Transport-only — prevents
            unmatched-route flash; expo-auth-session resolves the callback and
            sign-in redirects after success. */}
        <Stack.Screen name="callback" options={{ headerShown: false, animation: "none" }} />
      </Stack>
      {!authGate.loading && !navigatingToAuth && productAvailable ? <PinModal /> : null}
      {authGate.loading || agreementLoading || navigatingToAuth ? (
        <View style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}>
          <SessionLoadingBoundary />
        </View>
      ) : null}
    </View>
  );
}

export default function RootLayout() {
  const colorScheme = useColorScheme();
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <SafeAreaProvider>
          <PlatformCapabilitiesProvider>
            <AppThemeProvider>
              <ServerRegistryProvider>
              <PushLifecycleProvider>
                <AuthProvider>
                  <CryptoDeviceAdmissionBoundary>
                    <PushLifecycleBridge />
                    <ArtifactEventsProvider>
                      <RealtimeProvider>
                      <UserAgreementProvider>
                        <NotificationStateProvider>
                          <InboundIntentProvider>
                            <RemoteHostsProvider>
                              <VoiceProvider>
                                <AutoApproveProvider>
                                  <AttentionProvider>
                                    <ThemeProvider value={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
                                      <View style={{ flex: 1 }} onStartShouldSetResponderCapture={observeMobileTouchStart}>
                                        <RootShell />
                                      </View>
                                      <StatusBar style="auto" />
                                    </ThemeProvider>
                                  </AttentionProvider>
                                </AutoApproveProvider>
                              </VoiceProvider>
                            </RemoteHostsProvider>
                          </InboundIntentProvider>
                        </NotificationStateProvider>
                      </UserAgreementProvider>
                      </RealtimeProvider>
                    </ArtifactEventsProvider>
                  </CryptoDeviceAdmissionBoundary>
                </AuthProvider>
              </PushLifecycleProvider>
              </ServerRegistryProvider>
            </AppThemeProvider>
          </PlatformCapabilitiesProvider>
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
