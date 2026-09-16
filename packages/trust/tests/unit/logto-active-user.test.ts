/** D458 — strict, fail-closed Logto activity checks for remote authority. */

import { afterEach, describe, expect, test } from "bun:test";
import {
  verifyLogtoActiveUserForAuthority,
  type StrictLogtoActiveUserClient,
} from "../../src/logto-active-user";
import {
  checkLogtoRevocation,
  _resetRevocationCacheForTests,
  _setLogtoAdminResolverForTests,
  _setRevocationWarnLoggerForTests,
} from "../../src/logto-revocation-cache";
import {
  _resetLogtoAdminClientForTests,
  type LogtoAdminClient,
} from "../../src/logto-admin";

function client(
  isUserActive: (sub: string) => Promise<boolean>,
): StrictLogtoActiveUserClient {
  return { isUserActive };
}

afterEach(() => {
  _resetLogtoAdminClientForTests();
  _resetRevocationCacheForTests();
  _setLogtoAdminResolverForTests(null);
  _setRevocationWarnLoggerForTests(null);
});

describe("verifyLogtoActiveUserForAuthority", () => {
  test("permits only an active canonical Logto subject", async () => {
    const seen: string[] = [];
    const status = await verifyLogtoActiveUserForAuthority("logto-sub-1", {
      client: client(async (sub) => {
        seen.push(sub);
        return true;
      }),
    });

    expect(status).toBe("active");
    expect(seen).toEqual(["logto-sub-1"]);
  });

  test("denies suspended or missing Logto subjects", async () => {
    const suspended = await verifyLogtoActiveUserForAuthority("suspended", {
      client: client(async () => false),
    });
    const missing = await verifyLogtoActiveUserForAuthority("missing", {
      client: client(async () => false),
    });

    expect(suspended).toBe("inactive");
    expect(missing).toBe("inactive");
  });

  test("fails closed when the Management API errors or times out", async () => {
    const unavailable = await verifyLogtoActiveUserForAuthority("user-1", {
      client: client(async () => {
        throw new Error("management API unavailable");
      }),
    });
    const timedOut = await verifyLogtoActiveUserForAuthority("user-2", {
      client: client(async () => new Promise<boolean>(() => undefined)),
      timeoutMs: 1,
    });

    expect(unavailable).toBe("unavailable");
    expect(timedOut).toBe("unavailable");
  });

  test("fails closed when strict authority verification has no M2M configuration", async () => {
    const original = {
      endpoint: process.env["LOGTO_ENDPOINT"],
      internalEndpoint: process.env["LOGTO_ENDPOINT_INTERNAL"],
      appId: process.env["LOGTO_M2M_APP_ID"],
      appSecret: process.env["LOGTO_M2M_APP_SECRET"],
    };
    _resetLogtoAdminClientForTests();
    delete process.env["LOGTO_ENDPOINT"];
    delete process.env["LOGTO_ENDPOINT_INTERNAL"];
    delete process.env["LOGTO_M2M_APP_ID"];
    delete process.env["LOGTO_M2M_APP_SECRET"];

    try {
      expect(
        await verifyLogtoActiveUserForAuthority("user-without-m2m-config"),
      ).toBe("unavailable");
    } finally {
      if (original.endpoint === undefined) delete process.env["LOGTO_ENDPOINT"];
      else process.env["LOGTO_ENDPOINT"] = original.endpoint;
      if (original.internalEndpoint === undefined) {
        delete process.env["LOGTO_ENDPOINT_INTERNAL"];
      } else process.env["LOGTO_ENDPOINT_INTERNAL"] = original.internalEndpoint;
      if (original.appId === undefined) delete process.env["LOGTO_M2M_APP_ID"];
      else process.env["LOGTO_M2M_APP_ID"] = original.appId;
      if (original.appSecret === undefined) delete process.env["LOGTO_M2M_APP_SECRET"];
      else process.env["LOGTO_M2M_APP_SECRET"] = original.appSecret;
    }
  });

  test("rejects malformed subjects before calling the Management API", async () => {
    let calls = 0;
    const strictClient = client(async () => {
      calls++;
      return true;
    });

    expect(
      await verifyLogtoActiveUserForAuthority("   ", {
        client: strictClient,
      }),
    ).toBe("invalid-subject");
    expect(
      await verifyLogtoActiveUserForAuthority(undefined, {
        client: strictClient,
      }),
    ).toBe("invalid-subject");
    expect(calls).toBe(0);
  });

  test("does not alter the ordinary revocation adapter's fail-open outage posture", async () => {
    _setLogtoAdminResolverForTests(
      () =>
        client(async () => {
          throw new Error("management API unavailable");
        }) as LogtoAdminClient,
    );
    _setRevocationWarnLoggerForTests(() => undefined);

    expect(await checkLogtoRevocation("ordinary-request-sub")).toBe(true);
  });
});
