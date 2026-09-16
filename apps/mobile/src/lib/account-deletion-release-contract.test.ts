import { describe, expect, test } from "bun:test";

const accountRoute = await Bun.file(
  new URL("../../../../packages/server/src/routes/account.ts", import.meta.url),
).text();
const deletionService = await Bun.file(
  new URL("../../../../packages/server/src/lib/user-account-deletion.ts", import.meta.url),
).text();
const mobileScreen = await Bun.file(
  new URL("../app/(drawer)/(tabs)/settings/account-deletion.tsx", import.meta.url),
).text();

describe("public account deletion release contract", () => {
  test("requires exact confirmation and fresh authentication before mutation", () => {
    const confirmation = accountRoute.indexOf('body?.["confirmation"] !== "DELETE MY ACCOUNT"');
    const freshAuth = accountRoute.indexOf("requireFreshLogtoAccessToken(request, reply)", confirmation);
    const deletion = accountRoute.indexOf("deleteLocalUserAccount(userId)", freshAuth);

    expect(confirmation).toBeGreaterThan(-1);
    expect(freshAuth).toBeGreaterThan(confirmation);
    expect(deletion).toBeGreaterThan(freshAuth);
  });

  test("removes restrictive push dependents before the user row", () => {
    const deliveries = deletionService.indexOf("delete(pushNotificationDeliveries)");
    const testIntents = deletionService.indexOf("delete(pushNotificationTestIntents)");
    const bindings = deletionService.indexOf("delete(pushInstallationBindings)");
    const user = deletionService.indexOf("delete(users)");

    expect(deliveries).toBeGreaterThan(-1);
    expect(testIntents).toBeGreaterThan(deliveries);
    expect(bindings).toBeGreaterThan(testIntents);
    expect(user).toBeGreaterThan(bindings);
  });

  test("names the server, distinguishes phone removal, and cleans locally only after server success", () => {
    const reauth = mobileScreen.indexOf("await reauthenticate()");
    const deletion = mobileScreen.indexOf(".deleteAccount()", reauth);
    const localCleanup = mobileScreen.indexOf("await finishLocalRemoval()", deletion);

    expect(mobileScreen).toContain("Delete this server account");
    expect(mobileScreen).toContain("different from removing a saved server from your phone");
    expect(mobileScreen).toContain("Other saved Nautilo servers and their accounts are not affected");
    expect(reauth).toBeGreaterThan(-1);
    expect(deletion).toBeGreaterThan(reauth);
    expect(localCleanup).toBeGreaterThan(deletion);
  });

  test("does not invite a protected account to retry a deletion it cannot terminate", () => {
    expect(mobileScreen).toContain('case "protected_custody"');
    expect(mobileScreen).toContain("requires a compatible newer Nautilo release or operator path");
    expect(mobileScreen).toContain("do not retry deletion");
  });

  test("explains that externally active media must finish before deletion", () => {
    expect(mobileScreen).toContain('case "active_media_operation"');
    expect(mobileScreen).toContain("active media work with a provider");
    expect(mobileScreen).toContain("cleanup to complete");
  });
});
