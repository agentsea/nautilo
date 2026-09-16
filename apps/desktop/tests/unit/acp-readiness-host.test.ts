import { describe, expect, test } from "bun:test";
import {
  ElectronHermesAcpReadinessHost,
  HERMES_ACP_CHECK_ARGS,
  HERMES_ACP_VERSION_ARGS,
  type HermesAcpNativeProbe,
} from "../../electron/acp-readiness-host";
import type { RelayAcpReadinessCommand, RelayAcpSession } from "@nautilo/relay";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scope: RelayAcpSession = {
  relayId: "relay-1", relaySessionId: "session-1", desktopSessionId: "desktop-1",
  pairingGenerationRef: "pair-1", selectedProtocolVersion: 13, capabilityRevision: 2,
};

describe("D452 Electron Hermes readiness host", () => {
  test("runs only the locked probes after exact selection and returns no native evidence", async () => {
    const calls: unknown[] = [];
    const probe: HermesAcpNativeProbe = { run: async (input) => {
      calls.push(input);
      return input.args === HERMES_ACP_VERSION_ARGS
        ? { state: "output", stdout: new TextEncoder().encode("0.20.4") }
        : { state: "output", stdout: new Uint8Array() };
    } };
    const host = new ElectronHermesAcpReadinessHost(probe);
    const replies: unknown[] = [];
    host.onRegistered(scope, { send: (message) => { replies.push(message); return true; } });
    const command: RelayAcpReadinessCommand = {
      type: "relay:acp-readiness", requestId: "request-1", scope, registrationId: "hermes-acp",
    };
    await host.onReadiness(command);
    expect(calls).toEqual([
      { executableBasename: "hermes", args: HERMES_ACP_VERSION_ARGS, timeoutMs: 3_000, maxOutputBytes: 4_096, shell: false },
      { executableBasename: "hermes", args: HERMES_ACP_CHECK_ARGS, timeoutMs: 5_000, maxOutputBytes: 4_096, shell: false },
    ]);
    expect(replies).toEqual([{
      type: "relay:acp-readiness-result", requestId: "request-1", scope,
      registrationId: "hermes-acp", state: "ready",
    }]);
  });

  test("does not probe on registration/listing or a stale socket scope", async () => {
    let calls = 0;
    const host = new ElectronHermesAcpReadinessHost({ run: async () => {
      calls += 1;
      return { state: "missing" };
    } });
    host.onRegistered(scope, { send: () => true });
    expect(calls).toBe(0);
    await host.onReadiness({
      type: "relay:acp-readiness", requestId: "stale", registrationId: "hermes-acp",
      scope: { ...scope, pairingGenerationRef: "old" },
    });
    expect(calls).toBe(0);
  });

  test("coalesces concurrent exact-session readiness calls and fences a disconnected session", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const host = new ElectronHermesAcpReadinessHost({ run: async (input) => {
      calls += 1;
      await gate;
      return input.args === HERMES_ACP_VERSION_ARGS
        ? { state: "output", stdout: new TextEncoder().encode("0.20.4") }
        : { state: "output", stdout: new Uint8Array() };
    } });
    const replies: unknown[] = [];
    host.onRegistered(scope, { send: (message) => { replies.push(message); return true; } });
    const first = host.onReadiness({ type: "relay:acp-readiness", requestId: "one", scope, registrationId: "hermes-acp" });
    const second = host.onReadiness({ type: "relay:acp-readiness", requestId: "two", scope, registrationId: "hermes-acp" });
    expect(calls).toBe(1);
    host.onDisconnected();
    release?.();
    await Promise.all([first, second]);
    expect(calls).toBe(2);
    expect(replies).toEqual([]);
  });

  test("maps only fixed result enums and never infers authentication from a failed check", async () => {
    const host = new ElectronHermesAcpReadinessHost({ run: async (input) =>
      input.args === HERMES_ACP_VERSION_ARGS
        ? { state: "output", stdout: new TextEncoder().encode("0.20.4") }
        : { state: "unavailable" },
    });
    const replies: unknown[] = [];
    host.onRegistered(scope, { send: (message) => { replies.push(message); return true; } });
    await host.onReadiness({ type: "relay:acp-readiness", requestId: "request-1", scope, registrationId: "hermes-acp" });
    expect(replies).toEqual([expect.objectContaining({ state: "unavailable" })]);
  });

  test("uses a fresh allow-listed probe environment and bounded valid PATH entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nautilo-hermes-acp-"));
    const executable = join(directory, "hermes");
    const previousPath = process.env["PATH"];
    const previousSecret = process.env["HERMES_ACP_TEST_SECRET"];
    try {
      await writeFile(executable, "#!/bin/sh\nif [ \"${HERMES_ACP_TEST_SECRET:-}\" = \"present\" ]; then printf leaked; else printf 0.20.4; fi\n", "utf8");
      await chmod(executable, 0o755);
      // The first entry is invalid by the 4KiB limit; the valid entry must
      // still be found, while the secret cannot survive into the subprocess.
      process.env["PATH"] = `${"x".repeat(4_097)}:${directory}`;
      process.env["HERMES_ACP_TEST_SECRET"] = "present";
      const host = new ElectronHermesAcpReadinessHost((await import("../../electron/acp-readiness-host")).createElectronHermesAcpNativeProbe());
      const replies: unknown[] = [];
      host.onRegistered(scope, { send: (message) => { replies.push(message); return true; } });
      await host.onReadiness({ type: "relay:acp-readiness", requestId: "environment", scope, registrationId: "hermes-acp" });
      expect(replies).toEqual([expect.objectContaining({ state: "ready" })]);
    } finally {
      if (previousPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = previousPath;
      if (previousSecret === undefined) delete process.env["HERMES_ACP_TEST_SECRET"]; else process.env["HERMES_ACP_TEST_SECRET"] = previousSecret;
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects a single oversized stdout chunk without retaining it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nautilo-hermes-acp-"));
    const executable = join(directory, "hermes");
    const previousPath = process.env["PATH"];
    try {
      await writeFile(executable, "#!/bin/sh\nprintf '%*s' 4097 '' | /usr/bin/tr ' ' x\n", "utf8");
      await chmod(executable, 0o755);
      process.env["PATH"] = directory;
      const host = new ElectronHermesAcpReadinessHost((await import("../../electron/acp-readiness-host")).createElectronHermesAcpNativeProbe());
      const replies: unknown[] = [];
      host.onRegistered(scope, { send: (message) => { replies.push(message); return true; } });
      await host.onReadiness({ type: "relay:acp-readiness", requestId: "overflow", scope, registrationId: "hermes-acp" });
      expect(replies).toEqual([expect.objectContaining({ state: "incompatible" })]);
    } finally {
      if (previousPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = previousPath;
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does not search a valid Hermes candidate after the first 32 PATH entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nautilo-hermes-acp-"));
    const executable = join(directory, "hermes");
    const previousPath = process.env["PATH"];
    try {
      await writeFile(executable, "#!/bin/sh\nprintf 0.20.4\n", "utf8");
      await chmod(executable, 0o755);
      process.env["PATH"] = `${Array.from({ length: 32 }, (_, index) => `/missing-hermes-${index}`).join(":")}:${directory}`;
      const host = new ElectronHermesAcpReadinessHost((await import("../../electron/acp-readiness-host")).createElectronHermesAcpNativeProbe());
      const replies: unknown[] = [];
      host.onRegistered(scope, { send: (message) => { replies.push(message); return true; } });
      await host.onReadiness({ type: "relay:acp-readiness", requestId: "bound", scope, registrationId: "hermes-acp" });
      expect(replies).toEqual([expect.objectContaining({ state: "missing" })]);
    } finally {
      if (previousPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = previousPath;
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("terminates a timed-out probe process group before returning", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nautilo-hermes-acp-"));
    const executable = join(directory, "hermes");
    const marker = join(directory, "pid");
    const previousPath = process.env["PATH"];
    try {
      await writeFile(executable, `#!/bin/sh\ntrap '' TERM\nprintf '%s' \"$$\" > ${marker}\nwhile true; do /bin/sleep 1; done\n`, "utf8");
      await chmod(executable, 0o755);
      process.env["PATH"] = directory;
      const host = new ElectronHermesAcpReadinessHost((await import("../../electron/acp-readiness-host")).createElectronHermesAcpNativeProbe());
      const replies: unknown[] = [];
      host.onRegistered(scope, { send: (message) => { replies.push(message); return true; } });
      await host.onReadiness({ type: "relay:acp-readiness", requestId: "timeout", scope, registrationId: "hermes-acp" });
      expect(replies).toEqual([expect.objectContaining({ state: "incompatible" })]);
      const pid = Number(await readFile(marker, "utf8"));
      let running = true;
      try { process.kill(pid, 0); } catch { running = false; }
      expect(running).toBe(false);
    } finally {
      if (previousPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = previousPath;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
