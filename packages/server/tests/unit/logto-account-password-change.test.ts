/**
 * D104 — orchestration for verify-then-set Logto password change.
 */
import { describe, test, expect } from "bun:test";
import { executeLogtoPasswordChange } from "../../src/lib/logto-account-password-change";

const passingPolicy = {
  length: { min: 1, max: 256 },
  characterTypes: { min: 1 },
  rejects: {
    pwned: false,
    repetitionAndSequence: false,
    userInfo: false,
    words: [],
  },
};

const policyClient = {
  getPasswordPolicy: async () => passingPolicy,
  getUser: async () => ({
    id: "u",
    isSuspended: false,
    primaryEmail: "user@example.com",
    username: "user",
  }),
};

describe("executeLogtoPasswordChange", () => {
  test("rejects when new password equals current without calling Logto", async () => {
    const client = {
      ...policyClient,
      verifyUserPassword: async () => {
        throw new Error("verifyUserPassword should not run");
      },
      setUserPassword: async () => {},
    };
    const r = await executeLogtoPasswordChange(client, "u", "same", "same");
    expect(r.outcome).toBe("new_password_rejected");
  });

  test("returns wrong_current when verify is false", async () => {
    const client = {
      ...policyClient,
      verifyUserPassword: async () => false,
      setUserPassword: async () => {
        throw new Error("setUserPassword should not run");
      },
    };
    const r = await executeLogtoPasswordChange(
      client,
      "logto-sub",
      "old",
      "new",
    );
    expect(r).toEqual({ outcome: "wrong_current" });
  });

  test("returns success when verify and set both succeed", async () => {
    const client = {
      ...policyClient,
      verifyUserPassword: async () => true,
      setUserPassword: async () => {},
    };
    const r = await executeLogtoPasswordChange(
      client,
      "logto-sub",
      "old",
      "new-strong-9",
    );
    expect(r).toEqual({ outcome: "success" });
  });

  test("maps setUserPassword 422 to new_password_rejected", async () => {
    const client = {
      ...policyClient,
      verifyUserPassword: async () => true,
      setUserPassword: async () => {
        throw new Error("Logto setUserPassword failed: 422 weak");
      },
    };
    const r = await executeLogtoPasswordChange(client, "u", "a", "b");
    expect(r.outcome).toBe("new_password_rejected");
    if (r.outcome === "new_password_rejected") {
      expect(r.message.length).toBeGreaterThan(10);
    }
  });

  test("maps other set errors to logto_unavailable", async () => {
    const client = {
      ...policyClient,
      verifyUserPassword: async () => true,
      setUserPassword: async () => {
        throw new Error("Logto setUserPassword failed: 503 timeout");
      },
    };
    const r = await executeLogtoPasswordChange(client, "u", "a", "b");
    expect(r.outcome).toBe("logto_unavailable");
  });

  test("verify throws propagate to caller", async () => {
    const client = {
      ...policyClient,
      verifyUserPassword: async () => {
        throw new Error("Logto verifyUserPassword failed: 500 boom");
      },
      setUserPassword: async () => {},
    };
    expect(
      executeLogtoPasswordChange(client, "u", "a", "b"),
    ).rejects.toThrow(/500/);
  });

  test("rejects configured-policy failures before the password write", async () => {
    let writes = 0;
    const r = await executeLogtoPasswordChange(
      {
        ...policyClient,
        getPasswordPolicy: async () => ({
          ...passingPolicy,
          length: { min: 12, max: 256 },
        }),
        verifyUserPassword: async () => true,
        setUserPassword: async () => {
          writes += 1;
        },
      },
      "u",
      "old-password",
      "short",
    );
    expect(r.outcome).toBe("new_password_rejected");
    expect(writes).toBe(0);
  });

  test("fails closed before the write when policy cannot be loaded", async () => {
    let writes = 0;
    const r = await executeLogtoPasswordChange(
      {
        ...policyClient,
        getPasswordPolicy: async () => {
          throw new Error("unavailable");
        },
        verifyUserPassword: async () => true,
        setUserPassword: async () => {
          writes += 1;
        },
      },
      "u",
      "old-password",
      "new-password-9",
    );
    expect(r.outcome).toBe("logto_unavailable");
    expect(writes).toBe(0);
  });
});
