import { expect, test } from "bun:test";

const source = await Bun.file(new URL("./auth.web.tsx", import.meta.url)).text();

test("Mobile Web AuthProvider installs only the browser SDK session authority", () => {
  expect(source).toContain('from "@/lib/auth.web"');
  expect(source).toContain("new NautiloMobileWebLogtoClient(bootstrap.logto)");
  expect(source).toContain("installBrowserAuth({");
  expect(source).toContain("await session.initialize()");
  expect(source).not.toContain("SecureStore");
  expect(source).not.toContain("expo-auth-session");
  expect(source).not.toContain("nautilo://callback");
});

test("Mobile Web AuthProvider binds bearer use only after canonical whoami verification", () => {
  const verification = source.indexOf("browserViewerFromWhoami(await verificationClient.whoami())");
  const sharedBearer = source.indexOf("getApiClient(owner.serverUrl).setToken(token)");
  expect(verification).toBeGreaterThan(-1);
  expect(sharedBearer).toBeGreaterThan(verification);
  expect(source).toContain("ensureValidToken(owner.serverId, owner.serverUrl)");
  expect(source).toContain('setViewerState("verified")');
  expect(source).toContain('setStatus("signed-in")');
});

test("Mobile Web AuthProvider reacts to browser storage and auth-dead transitions", () => {
  expect(source).toContain('window.addEventListener("storage", onStorage)');
  expect(source).toContain("current.session.isAuthenticated()");
  expect(source).toContain("onAuthDead((serverId) => {");
  expect(source).toContain("clearBrowserAuthSession(owner.serverId)");
});

test("Web reauthentication cannot authorize a fenced action before redirect completion", () => {
  expect(source).toContain("const beginReauthentication = useCallback");
  expect(source).toContain("await owner.session.signIn(returnPath)");
  expect(source).toContain("Full-page browser reauthentication resumes from the callback");
  expect(source).toContain('throw new Error("Reauthentication continues in the browser.")');
});

test("a failed Web step-up preserves a still-valid session and reports no mutation", () => {
  expect(source).toContain("await session.isAuthenticated().catch(() => false)");
  expect(source).toContain('setSignInNotice("Verification did not finish. Nothing changed.")');
  expect(source).toContain("window.location.replace(settingsVerificationIncompletePath())");
});

test("a failed primary callback returns to visible sign-in with the SDK-owned safe route", () => {
  expect(source).toContain("failedMobileWebSignInPath(error.returnPath)");
  expect(source).toContain("window.location.replace(failedMobileWebSignInPath(error.returnPath))");
});
