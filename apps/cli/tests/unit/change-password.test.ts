import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createChangePasswordModule } from "../../src/commands/change-password.ts";
import type { RestrictedPasswordChangeClient } from "../../src/lib/authenticated-admin-client.ts";

function fakeClient(
  mustChangePassword: boolean,
  changePassword: (input: {
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
  }) => Promise<unknown>,
): RestrictedPasswordChangeClient {
  return {
    api: {
      changePassword,
      getHealth: async () => ({ status: "ok", logtoEndpoint: "https://id.example" }),
    },
    transport: { kind: "http", endpoint: "https://server.example" },
    profileName: "production",
    whoami: {
      sessionUserId: "user-1",
      sessionActorId: "actor-1",
      userIdentity: "person",
      handle: "person",
      displayName: "Person",
      externalId: "logto-1",
      instanceId: "instance-1",
      mustChangePassword,
      groups: [],
      capabilities: [],
      features: { office: { enabled: false } },
      highestRole: null,
    },
  } as unknown as RestrictedPasswordChangeClient;
}

async function captureOutput(run: () => Promise<void>): Promise<string> {
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = ((value: string | Uint8Array) => {
    output += typeof value === "string" ? value : Buffer.from(value).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = original;
  }
  return output;
}

describe("nautilo change-password", () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  test("changes a restricted password from hidden prompts without emitting secrets", async () => {
    const changePassword = mock(async () => ({ ok: true }));
    const prompts: string[] = [];
    const secrets = ["TEMP-CANARY", "NEW-CANARY-9!", "NEW-CANARY-9!"];
    const module = createChangePasswordModule({
      authenticate: async () => fakeClient(true, changePassword),
      readHidden: async (prompt) => {
        prompts.push(prompt);
        return secrets.shift() ?? "";
      },
      isStdinTty: () => true,
      isStderrTty: () => true,
    });

    const output = await captureOutput(() =>
      (module.handler as (argv: unknown) => Promise<void>)({ format: "json" }),
    );

    expect(changePassword).toHaveBeenCalledWith({
      currentPassword: "TEMP-CANARY",
      newPassword: "NEW-CANARY-9!",
      confirmPassword: "NEW-CANARY-9!",
    });
    expect(prompts).toHaveLength(3);
    expect(JSON.parse(output)).toMatchObject({
      schema: "nautilo.server-admin.v1",
      ok: true,
      data: { passwordChanged: true, restrictionCleared: true },
    });
    expect(output).not.toContain("CANARY");
    expect(process.exitCode).toBe(0);
  });

  test("rejects non-TTY restricted recovery before reading any password", async () => {
    const readHidden = mock(async () => "must-not-read");
    const changePassword = mock(async () => ({ ok: true }));
    const module = createChangePasswordModule({
      authenticate: async () => fakeClient(true, changePassword),
      readHidden,
      isStdinTty: () => false,
      isStderrTty: () => false,
    });

    const output = await captureOutput(() =>
      (module.handler as (argv: unknown) => Promise<void>)({ format: "json" }),
    );

    expect(readHidden).not.toHaveBeenCalled();
    expect(changePassword).not.toHaveBeenCalled();
    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      error: { code: "interactive_required" },
    });
    expect(process.exitCode).toBe(2);
  });

  test("does not write when password confirmation differs", async () => {
    const changePassword = mock(async () => ({ ok: true }));
    const secrets = ["temporary", "new-one", "different"];
    const module = createChangePasswordModule({
      authenticate: async () => fakeClient(true, changePassword),
      readHidden: async () => secrets.shift() ?? "",
      isStdinTty: () => true,
      isStderrTty: () => true,
    });

    const output = await captureOutput(() =>
      (module.handler as (argv: unknown) => Promise<void>)({ format: "json" }),
    );

    expect(changePassword).not.toHaveBeenCalled();
    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      error: { code: "password_confirmation_mismatch" },
    });
  });

  test("normal sessions can open hosted settings but JSON remains single-document and noninteractive", async () => {
    const changePassword = mock(async () => ({ ok: true }));
    const openUrl = mock(() => {});
    const module = createChangePasswordModule({
      authenticate: async () => fakeClient(false, changePassword),
      isStdinTty: () => false,
      isStderrTty: () => false,
      isHeadless: () => false,
      openUrl,
    });

    const output = await captureOutput(() =>
      (module.handler as (argv: unknown) => Promise<void>)({ format: "json" }),
    );

    expect(openUrl).not.toHaveBeenCalled();
    expect(changePassword).not.toHaveBeenCalled();
    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      error: { code: "interactive_required" },
    });
  });

  test("rejects an unsafe hosted-settings origin without printing or opening it", async () => {
    const openUrl = mock(() => {});
    const client = fakeClient(false, async () => ({ ok: true }));
    client.api.getHealth = async () => ({
      status: "ok",
      logtoEndpoint: "http://evil.example/\u001b]8;;https://phish.example\u0007",
    });
    const module = createChangePasswordModule({
      authenticate: async () => client,
      isStdinTty: () => false,
      isStderrTty: () => false,
      isHeadless: () => true,
      openUrl,
    });

    const output = await captureOutput(() =>
      (module.handler as (argv: unknown) => Promise<void>)({ format: "human", remote: true }),
    );

    expect(openUrl).not.toHaveBeenCalled();
    expect(output).not.toContain("evil.example");
    expect(output).not.toContain("phish.example");
    expect(process.exitCode).toBe(2);
  });
});
