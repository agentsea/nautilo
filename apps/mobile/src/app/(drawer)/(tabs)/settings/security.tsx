import { router, useNavigation } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Alert, AppState, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { AppBar, AppBarBackButton } from "@/components/app-bar";
import { Screen } from "@/components/screen";
import { PinForm } from "@/features/settings/pin-form";
import { PasswordForm } from "@/features/settings/password-form";
import { RecoveryCodesReveal } from "@/features/settings/recovery-codes-reveal";
import { clearRecoveryCodes, RECOVERY_CODE_FAMILIES, recoveryExitDisposition, revealRecoveryCodes } from "@/features/settings/recovery-controller";
import { createSecurityController, isFreshReauthRequired, securityErrorMessage, type PinDraft } from "@/features/settings/security-controller";
import { settingsScopeForVerifiedViewer } from "@/features/settings/settings-data-state";
import { createSettingsReauthFence, reauthenticateThenResume } from "@/lib/settings-reauth";
import { consumeSettingsReauthNavigation, settingsReauthReturnPath } from "@/lib/settings-reauth-navigation";
import { getApiClient } from "@/lib/api";
import { useAuth } from "@/providers/auth";
import { usePlatformCapabilities } from "@/providers/platform-capabilities";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

type PinResetMode = "closed" | "code" | "reauth";

export default function SecurityScreen() {
  const { activeServer } = useServers();
  const auth = useAuth();
  const platform = usePlatformCapabilities().platform;
  const navigation = useNavigation();
  const t = useAppTheme(); const styles = useMemo(() => createStyles(t), [t]);
  const controllerRef = useRef(createSecurityController()); const controller = controllerRef.current;
  const fenceRef = useRef(createSettingsReauthFence());
  const navigationBypassRef = useRef(false);
  const subscribe = useCallback((listener: () => void) => controller.state.subscribe(listener), [controller]);
  const snapshot = useSyncExternalStore(subscribe, () => controller.state.getState(), () => controller.state.getState());
  const [pinOpen, setPinOpen] = useState(false); const [pinReset, setPinReset] = useState<PinResetMode>("closed");
  const [pinError, setPinError] = useState<string | null>(null); const [passwordOpen, setPasswordOpen] = useState(false); const [passwordError, setPasswordError] = useState<string | null>(null);
  const [regenFamily, setRegenFamily] = useState<"pin" | "logto-account" | null>(null); const [regenPin, setRegenPin] = useState(""); const [recoveryBusy, setRecoveryBusy] = useState(false); const [revealFamily, setRevealFamily] = useState<"pin" | "logto-account" | null>(null); const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [secretFormEpoch, setSecretFormEpoch] = useState(0);
  const [verificationNotice, setVerificationNotice] = useState<string | null>(null);
  const scope = useMemo(() => settingsScopeForVerifiedViewer(activeServer, { status: auth.status, viewerState: auth.viewerState, viewer: auth.viewer }), [activeServer, auth.status, auth.viewer, auth.viewerState]);
  const scopeKey = scope ? `${scope.serverId}:${scope.userId}:${scope.actorId}` : "none";
  const previousScopeKeyRef = useRef(scopeKey);
  const api = activeServer ? getApiClient(activeServer.serverUrl) : null;

  const eraseSensitiveUi = useCallback(() => {
    fenceRef.current.discard();
    controller.state.clearSecret();
    setRevealFamily(null);
    setPinOpen(false);
    setPinReset("closed");
    setPasswordOpen(false);
    setRegenFamily(null);
    setRegenPin("");
    setPinError(null);
    setPasswordError(null);
    setRecoveryError(null);
    setVerificationNotice(null);
    setSecretFormEpoch((epoch) => epoch + 1);
  }, [controller]);

  useEffect(() => { controller.state.setScope(scope); if (scope && api) void controller.load(api); }, [api, controller, scope]);
  useEffect(() => () => { fenceRef.current.discard(); controller.state.clearSecret(); controller.state.setScope(null); }, [controller]);
  useEffect(() => {
    if (previousScopeKeyRef.current !== scopeKey) eraseSensitiveUi();
    previousScopeKeyRef.current = scopeKey;
  }, [eraseSensitiveUi, scopeKey]);
  useEffect(() => { const sub = AppState.addEventListener("change", (next) => { if (next !== "active") eraseSensitiveUi(); }); return () => sub.remove(); }, [eraseSensitiveUi]);

  const refresh = useCallback(() => { if (api) void controller.load(api); }, [api, controller]);
  const navigateBack = useCallback(() => { if (router.canGoBack()) router.back(); else router.replace("/(drawer)/(tabs)/settings"); }, []);
  const cancelPinEdit = useCallback(() => { setPinOpen(false); setPinReset("closed"); setPinError(null); setSecretFormEpoch((epoch) => epoch + 1); }, []);
  const openPinReset = useCallback((mode: Exclude<PinResetMode, "closed">) => { setPinOpen(false); setPinReset(mode); setPinError(null); setSecretFormEpoch((epoch) => epoch + 1); }, []);
  const cancelPasswordEdit = useCallback(() => { setPasswordOpen(false); setPasswordError(null); setSecretFormEpoch((epoch) => epoch + 1); }, []);
  useEffect(() => {
    if (!scope) return;
    const navigation = consumeSettingsReauthNavigation();
    if (!navigation) return;
    if (navigation.kind === "verification-incomplete") {
      setVerificationNotice("Verification did not finish. Nothing changed.");
      return;
    }
    if (navigation.intent === "reset-pin") {
      openPinReset("reauth");
      setVerificationNotice("Identity verified. Choose a new PIN.");
      return;
    }
    setRegenFamily("logto-account");
    setVerificationNotice("Identity verified. Confirm regeneration to continue.");
  }, [openPinReset, scope]);

  const beginWebPinReset = useCallback(async () => {
    setPinError(null);
    setVerificationNotice("Opening secure sign-in…");
    try {
      await auth.beginReauthentication(settingsReauthReturnPath("reset-pin"));
    } catch (error) {
      setVerificationNotice(securityErrorMessage(error, "Verification could not be started."));
    }
  }, [auth]);
  const savePin = async (draft: PinDraft) => { if (!api) return; setPinError(null); const wasEnrolled = data?.pinEnrolled === true; const result = await controller.savePin(api, draft); if (result.status === "saved") { if (!wasEnrolled && controller.state.getState().secret.status === "revealed") setRevealFamily("pin"); setPinOpen(false); return; } setPinError(result.message ?? "Could not save PIN."); };
  const resetPin = async (mode: PinResetMode, code: string, draft: Omit<PinDraft, "currentPin">) => {
    if (!api || !scope) return; setPinError(null);
    const run = async () => mode === "code" ? controller.resetPinWithCode(api, code, draft) : controller.resetPinAfterReauth(api, draft);
    let result = await run();
    if (mode === "reauth" && result.status === "failed" && result.message?.includes("recently-issued access token")) {
      if (platform === "web") {
        try {
          await auth.beginReauthentication(settingsReauthReturnPath("reset-pin"));
        } catch (error) {
          setPinError(securityErrorMessage(error, "Verification could not be started."));
        }
        return;
      }
      try { await reauthenticateThenResume(fenceRef.current, auth.reauthenticate, scope, async () => { result = await run(); }); } catch (error) { setPinError(securityErrorMessage(error, "Re-authentication cancelled.")); return; }
    }
    if (result.status === "saved") { setPinReset("closed"); setPinOpen(false); } else setPinError(result.message ?? "Could not reset PIN.");
  };
  const savePassword = async (value: { currentPassword: string; newPassword: string; confirmPassword: string }) => {
    if (!api) return; setPasswordError(null); const result = await controller.savePassword(api, value);
    if (result.status === "saved") { setPasswordOpen(false); return; }
    controller.state.clearSecret(); setRevealFamily(null); setPasswordError(result.message ?? "Could not save password.");
  };
  const regenerate = async (family: "pin" | "logto-account") => {
    if (!api || !scope || recoveryBusy) return; setRecoveryError(null); controller.state.clearSecret();
    if (family === "pin" && !regenPin) { setRecoveryError("Enter your current PIN to regenerate PIN recovery codes."); return; }
    const run = async () => family === "pin" ? api.regenerateRecoveryCodes({ pin: regenPin }) : api.regenerateLogtoRecoveryCodes();
    setRecoveryBusy(true); try {
      const output = await run();
      if (!output.recoveryCodes.length) { setRecoveryError("No recovery codes were returned. Existing codes may be unchanged; refresh and try again."); return; }
      const refreshed = await controller.load(api);
      if (refreshed.status !== "applied") { controller.state.clearSecret(); setRecoveryError("Could not confirm recovery-code status. No codes were revealed."); return; }
      revealRecoveryCodes(controller.state, output.recoveryCodes); setRevealFamily(family); setRegenPin(""); setRegenFamily(null);
    } catch (error) {
      if (isFreshReauthRequired(error)) {
        if (platform === "web" && family === "logto-account") {
          try {
            await auth.beginReauthentication(settingsReauthReturnPath("regenerate-account-codes"));
          } catch (reauthError) {
            setRecoveryError(securityErrorMessage(reauthError, "Verification could not be started."));
          }
        } else {
          try { await reauthenticateThenResume(fenceRef.current, auth.reauthenticate, scope, async () => {
            const output = await run();
            if (!output.recoveryCodes.length) throw new Error("No recovery codes were returned.");
            const refreshed = await controller.load(api);
            if (refreshed.status !== "applied") throw new Error("Could not confirm recovery-code status.");
            revealRecoveryCodes(controller.state, output.recoveryCodes); setRevealFamily(family); setRegenPin(""); setRegenFamily(null);
          }); } catch (reauthError) { setRecoveryError(securityErrorMessage(reauthError, "Re-authentication cancelled.")); }
        }
      } else setRecoveryError(securityErrorMessage(error, "Could not regenerate recovery codes."));
    } finally { setRecoveryBusy(false); }
  };
  const data = snapshot.data;
  const secret = snapshot.secret.status === "revealed" ? snapshot.secret.secret : null;
  const clearReveal = useCallback(() => { clearRecoveryCodes(controller.state); setRevealFamily(null); }, [controller]);
  const copy = useCallback((codes: string) => { void Clipboard.setStringAsync(codes); }, []);
  const discardThen = useCallback((action: () => void) => {
    navigationBypassRef.current = true;
    clearReveal();
    action();
  }, [clearReveal]);
  const confirmDiscard = useCallback((action: () => void) => {
    Alert.alert("Discard recovery codes?", "These one-time codes cannot be shown again after you leave this screen.", [
      { text: "Keep viewing", style: "cancel" },
      { text: "Discard codes", style: "destructive", onPress: () => discardThen(action) },
    ]);
  }, [discardThen]);
  const goBack = useCallback(() => {
    if (recoveryExitDisposition(secret !== null, "navigation") === "confirm-discard") { confirmDiscard(navigateBack); return; }
    navigateBack();
  }, [confirmDiscard, navigateBack, secret]);
  useEffect(() => navigation.addListener("beforeRemove", (event) => {
    if (navigationBypassRef.current) { navigationBypassRef.current = false; return; }
    if (recoveryExitDisposition(secret !== null, "navigation") !== "confirm-discard") return;
    event.preventDefault();
    confirmDiscard(() => { navigationBypassRef.current = true; navigation.dispatch(event.data.action); });
  }), [confirmDiscard, navigation, secret]);

  return <View style={styles.container}><AppBar title="Security" left={<AppBarBackButton onPress={goBack} />} />
    {!scope ? <View style={styles.status}><Text style={styles.error}>{auth.status === "signed-out" ? "Sign in to manage security." : "Verify your identity to manage security."}</Text></View> : !data && !snapshot.loadError ? <View style={styles.status}><ActivityIndicator color={t.color.brand.accent} /></View> : snapshot.loadError ? <View style={styles.status}><Text style={styles.error}>{securityErrorMessage(snapshot.loadError, "Could not load security settings.")}</Text><Pressable style={styles.button} onPress={refresh}><Text style={styles.buttonText}>Try again</Text></Pressable></View> : data ? <Screen edgeTop={false} contentStyle={styles.content}>
      {verificationNotice ? <Text style={styles.notice} accessibilityLiveRegion="polite">{verificationNotice}</Text> : null}
      {secret ? <RecoveryCodesReveal family={revealFamily ?? "pin"} codes={secret} onCopy={copy} onAcknowledge={clearReveal} onClear={clearReveal} /> : null}
      <Section title="Approval PIN" description="Separate from your Logto password; used for quick approval and identity checks.">
        {pinOpen ? <PinForm key={`pin-${secretFormEpoch}`} enrolled={data.pinEnrolled} busy={snapshot.mutating} error={pinError} onSave={(draft) => void savePin(draft)} onCancel={cancelPinEdit} onReset={() => openPinReset("code")} /> : <Pressable style={styles.button} onPress={() => { setPinOpen(true); setPinError(null); }}><Text style={styles.buttonText}>{data.pinEnrolled ? "Change PIN" : "Set PIN"}</Text></Pressable>}
        {pinReset !== "closed" ? <ResetPinForm key={`reset-${secretFormEpoch}`} mode={pinReset} busy={snapshot.mutating} error={pinError} onCancel={() => { setPinReset("closed"); setPinError(null); setSecretFormEpoch((epoch) => epoch + 1); }} onSubmit={(code, draft) => void resetPin(pinReset, code, draft)} /> : <View style={styles.row}><Pressable style={styles.secondary} onPress={() => openPinReset("code")}><Text style={styles.secondaryText}>Reset with recovery code</Text></Pressable><Pressable style={styles.secondary} onPress={() => { if (platform === "web") void beginWebPinReset(); else openPinReset("reauth"); }}><Text style={styles.secondaryText}>Reset with Logto</Text></Pressable></View>}
      </Section>
      <Section title="PIN recovery codes" description={data.pinEnrolled ? `${data.pinRecoveryCodes.remaining} unused of ${data.pinRecoveryCodes.total} issued.` : "Set a PIN first to receive PIN recovery codes."}>
        <Pressable disabled={!data.pinEnrolled || recoveryBusy} style={[styles.secondary, !data.pinEnrolled && styles.disabled]} onPress={() => setRegenFamily("pin")}><Text style={styles.secondaryText}>Regenerate PIN recovery codes</Text></Pressable>
      </Section>
      {data.account.linkedToLogto ? <><Section title="Password" description="Your Logto password is managed through this linked account.">
        {passwordOpen || data.account.requiresPasswordChange ? <PasswordForm key={`password-${secretFormEpoch}`} busy={snapshot.mutating} error={passwordError} required={data.account.requiresPasswordChange} onSave={(value) => void savePassword(value)} onCancel={cancelPasswordEdit} /> : <Pressable style={styles.button} onPress={() => setPasswordOpen(true)}><Text style={styles.buttonText}>Change password</Text></Pressable>}
      </Section><Section title={RECOVERY_CODE_FAMILIES["logto-account"].title} description={data.logtoRecoveryCodes ? `${data.logtoRecoveryCodes.remaining} unused of ${data.logtoRecoveryCodes.total} issued.` : "Separate one-time codes for recovering your Logto account."}><Pressable disabled={recoveryBusy} style={styles.secondary} onPress={() => setRegenFamily("logto-account")}><Text style={styles.secondaryText}>Regenerate account recovery codes</Text></Pressable></Section></> : null}
      {regenFamily ? <View style={styles.confirm}><Text style={styles.warning}>{RECOVERY_CODE_FAMILIES[regenFamily].confirmation}</Text>{regenFamily === "pin" ? <TextInput value={regenPin} onChangeText={(value) => setRegenPin(value.replace(/\D/g, "").slice(0, 8))} secureTextEntry textContentType="password" autoComplete="off" keyboardType="number-pad" maxLength={8} style={styles.input} placeholder="Current PIN" placeholderTextColor={t.color.text.muted} accessibilityLabel="Current PIN for recovery-code regeneration" /> : <Text style={styles.description}>You may be asked to sign in again to verify it’s you.</Text>}{recoveryError ? <Text style={styles.error}>{recoveryError}</Text> : null}<View style={styles.row}><Pressable disabled={recoveryBusy} style={styles.secondary} onPress={() => { setRegenPin(""); setRegenFamily(null); }}><Text style={styles.secondaryText}>Cancel</Text></Pressable><Pressable disabled={recoveryBusy} style={styles.button} onPress={() => void regenerate(regenFamily)}><Text style={styles.buttonText}>{recoveryBusy ? "Working…" : "Regenerate"}</Text></Pressable></View></View> : null}
    </Screen> : null}</View>;
}

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) { const t = useAppTheme(); const styles = useMemo(() => createStyles(t), [t]); return <View style={styles.section}><Text style={styles.title}>{title}</Text><Text style={styles.description}>{description}</Text>{children}</View>; }
function ResetPinForm({ mode, busy, error, onCancel, onSubmit }: { mode: Exclude<PinResetMode, "closed">; busy: boolean; error: string | null; onCancel: () => void; onSubmit: (code: string, draft: { newPin: string; confirmPin: string }) => void }) { const t = useAppTheme(); const styles = useMemo(() => createStyles(t), [t]); const [code, setCode] = useState(""); const [newPin, setNewPin] = useState(""); const [confirmPin, setConfirmPin] = useState(""); const digits = (value: string) => value.replace(/\D/g, "").slice(0, 8); return <View style={styles.reset}><Text style={styles.description}>{mode === "code" ? "Use a PIN recovery code. This is distinct from Logto account recovery codes." : "Logto verification is required before this PIN can be reset."}</Text>{mode === "code" ? <TextInput value={code} onChangeText={setCode} secureTextEntry autoCapitalize="characters" autoCorrect={false} textContentType="password" style={styles.input} placeholder="PIN recovery code" placeholderTextColor={t.color.text.muted} /> : null}<TextInput value={newPin} onChangeText={(next) => setNewPin(digits(next))} secureTextEntry keyboardType="number-pad" maxLength={8} textContentType="password" style={styles.input} placeholder="New PIN" placeholderTextColor={t.color.text.muted} /><TextInput value={confirmPin} onChangeText={(next) => setConfirmPin(digits(next))} secureTextEntry keyboardType="number-pad" maxLength={8} textContentType="password" style={styles.input} placeholder="Confirm new PIN" placeholderTextColor={t.color.text.muted} />{error ? <Text style={styles.error}>{error}</Text> : null}<View style={styles.row}><Pressable style={styles.secondary} disabled={busy} onPress={onCancel}><Text style={styles.secondaryText}>Cancel</Text></Pressable><Pressable style={styles.button} disabled={busy} onPress={() => onSubmit(code, { newPin, confirmPin })}><Text style={styles.buttonText}>{busy ? "Saving…" : "Reset PIN"}</Text></Pressable></View></View>; }
function createStyles(t: AppTheme) { return StyleSheet.create({ container: { flex: 1, backgroundColor: t.color.surface.background }, content: { gap: t.spacing.lg }, section: { gap: t.spacing.md, padding: t.spacing.lg, borderRadius: t.radii.lg, backgroundColor: t.color.surface.panel, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default }, title: { ...t.typography.subheading, color: t.color.text.foreground }, description: { ...t.typography.body, color: t.color.text.muted }, notice: { ...t.typography.body, color: t.color.text.foreground, padding: t.spacing.md, borderRadius: t.radii.md, backgroundColor: t.color.surface.panel }, input: { ...t.typography.body, color: t.color.text.foreground, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default, borderRadius: t.radii.md, padding: t.spacing.md }, status: { flex: 1, alignItems: "center", justifyContent: "center", gap: t.spacing.md, padding: t.spacing.xl }, button: { alignSelf: "flex-start", padding: t.spacing.md, borderRadius: t.radii.md, backgroundColor: t.color.brand.accent }, buttonText: { ...t.typography.bodyStrong, color: t.color.surface.background }, secondary: { alignSelf: "flex-start", padding: t.spacing.md, borderRadius: t.radii.md, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default }, secondaryText: { ...t.typography.bodyStrong, color: t.color.text.foreground }, disabled: { opacity: 0.5 }, reset: { gap: t.spacing.sm }, confirm: { gap: t.spacing.md, padding: t.spacing.lg, borderRadius: t.radii.lg, backgroundColor: t.color.surface.panel, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.status.warning }, warning: { ...t.typography.body, color: t.color.status.warning }, error: { ...t.typography.body, color: t.color.status.error }, row: { flexDirection: "row", gap: t.spacing.sm, flexWrap: "wrap" } }); }
