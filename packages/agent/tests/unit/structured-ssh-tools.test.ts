import { describe, expect, test } from "bun:test";
import { ToolCatalog } from "@nautilo/catalog";
import {
  createStructuredSshAuthTool,
  createStructuredSshCopyDownloadTool,
  createStructuredSshCopyUploadTool,
  createStructuredSshExecTool,
  createStructuredSshOutputTool,
  resolveStructuredSshTimeout,
  structuredSshAuthSchema,
  structuredSshCopyDownloadSchema,
  structuredSshCopyUploadSchema,
  structuredSshExecSchema,
  structuredSshOutputSchema,
} from "../../src/tools/structured-ssh/structured-ssh";
import { expandToolFamilies, resolveIntentPacks } from "../../src/tools/exposure/manifest";
import { registerAllTools } from "../../src/tools/register-all";

const destination = { host: "build.example.test", user: "deploy", port: 2222 };
const namedDestination = { connection: "build" };

describe("D500 structured SSH agent tools", () => {
  test("uses explicit bounded operation budgets and requires a reviewed reason only above 30 minutes", () => {
    expect(resolveStructuredSshTimeout({})).toEqual({ ok: true, timeoutSeconds: 300 });
    expect(resolveStructuredSshTimeout({ timeout_seconds: 1_800 })).toEqual({ ok: true, timeoutSeconds: 1_800 });
    expect(resolveStructuredSshTimeout({ timeout_seconds: 1_801 })).toMatchObject({ ok: false });
    expect(resolveStructuredSshTimeout({ timeout_seconds: 1_801, timeout_reason: "Long deployment migration" }))
      .toEqual({ ok: true, timeoutSeconds: 1_801, timeoutReason: "Long deployment migration" });
    expect(resolveStructuredSshTimeout({ timeout_seconds: 14_400, timeout_reason: "Long deployment migration" })).toMatchObject({ ok: true });
    for (const malformed of [0, 14_401, 1.5, "300"]) {
      expect(resolveStructuredSshTimeout({ timeout_seconds: malformed })).toMatchObject({ ok: false });
    }
    expect(resolveStructuredSshTimeout({ timeout_seconds: 300, timeout_reason: "not applicable" })).toMatchObject({ ok: false });
    expect(resolveStructuredSshTimeout({ timeout_seconds: 1_801, timeout_reason: "short" })).toMatchObject({ ok: false });
  });

  test("strictly validates Desktop-local output continuation requests", () => {
    const reference = "a".repeat(43);
    expect(structuredSshOutputSchema.safeParse({ output_artifact: { reference, offset_bytes: 0, max_bytes: 4096 } }).success).toBe(true);
    expect(structuredSshOutputSchema.safeParse({ output_artifact: { reference, operation: "search", query: "failed", max_matches: 4 } }).success).toBe(true);
    expect(structuredSshOutputSchema.safeParse({ output_artifact: { reference: "short" } }).success).toBe(false);
    expect(structuredSshOutputSchema.safeParse({ output_artifact: { reference, command: "ssh again" } }).success).toBe(false);
    expect(createStructuredSshOutputTool().name).toBe("structured_ssh_output");
  });

  test("requires one strict named or ad hoc destination variant and a structured exec/copy action", () => {
    expect(structuredSshAuthSchema.safeParse({ destination }).success).toBe(true);
    expect(structuredSshAuthSchema.safeParse({ destination: namedDestination }).success).toBe(true);
    expect(structuredSshAuthSchema.safeParse({}).success).toBe(false);
    expect(structuredSshAuthSchema.safeParse({ grant_ref: "must-not-cross" }).success).toBe(false);
    expect(structuredSshAuthSchema.safeParse({ destination: { ...destination, identityPath: "/private/key" } }).success).toBe(false);
    expect(structuredSshAuthSchema.safeParse({ destination: { host: "build.example.test", port: 0 } }).success).toBe(false);
    expect(structuredSshAuthSchema.safeParse({ destination: { host: "build.example.test" } }).success).toBe(false);
    expect(structuredSshAuthSchema.safeParse({ destination: { connection: "build", host: "build.example.test", user: "deploy" } }).success).toBe(false);
    expect(structuredSshAuthSchema.safeParse({ destination: { host: "build.example.test", user: "root", sshOption: "-oProxyCommand" } }).success).toBe(false);

    expect(structuredSshExecSchema.safeParse({
      destination,
      program: "printf",
      argv: ["hello", "world"],
    }).success).toBe(true);
    expect(structuredSshExecSchema.safeParse({
      destination,
      program: "curl",
      argv: ["-fsS", "-o", "/dev/null", "-w", "%{http_code}\n", "https://build.example.test/"],
    }).success).toBe(true);
    expect(structuredSshExecSchema.safeParse({
      destination,
      program: "printf",
      argv: [],
      user: "root",
    }).success).toBe(false);

    expect(structuredSshCopyUploadSchema.safeParse({ destination, localPath: "releases/release.tgz", remotePath: "releases/release.tgz" }).success).toBe(true);
    expect(structuredSshCopyDownloadSchema.safeParse({ destination, remotePath: "/var/tmp/build.log", localPath: "logs/build.log" }).success).toBe(true);
    for (const remotePath of ["../escape", "release;id", "release/$(id)", "release\nnext"]) {
      expect(structuredSshCopyUploadSchema.safeParse({ destination, localPath: "releases/release.tgz", remotePath }).success).toBe(false);
    }
    for (const localPath of ["/workspace/release.tgz", "C:\\workspace\\release.tgz", "../escape", "release/../escape", "-option"]) {
      expect(structuredSshCopyUploadSchema.safeParse({ destination, localPath, remotePath: "releases/release.tgz" }).success).toBe(false);
    }
    expect(structuredSshExecSchema.safeParse({
      destination,
      program: "-sh",
      argv: [],
    }).success).toBe(false);
    expect(structuredSshExecSchema.safeParse({
      destination,
      program: "printf",
      argv: Array.from({ length: 33 }, () => "x"),
    }).success).toBe(false);
    expect(structuredSshExecSchema.safeParse({
      destination,
      program: "printf",
      argv: ["x".repeat(1_025)],
    }).success).toBe(false);
  });

  test("rejects direct invocation instead of providing a shell fallback", async () => {
    const authError = await createStructuredSshAuthTool().invoke({ destination })
      .then(() => null, (error: unknown) => error);
    expect(authError).toBeInstanceOf(Error);
    expect((authError as Error).message).toContain("relay tool");

    const execError = await createStructuredSshExecTool().invoke({
      destination,
      program: "true",
      argv: [],
    }).then(() => null, (error: unknown) => error);
    expect(execError).toBeInstanceOf(Error);
    expect((execError as Error).message).toContain("relay tool");

    const copyError = await createStructuredSshCopyUploadTool().invoke({ destination, localPath: "release/a", remotePath: "release/a" })
      .then(() => null, (error: unknown) => error);
    expect(copyError).toBeInstanceOf(Error);
    expect((copyError as Error).message).toContain("relay tool");
    expect(createStructuredSshCopyDownloadTool().name).toBe("structured_ssh_copy_download");
  });

  test("uses only the dedicated exact SSH review and remains gated by structured SSH readiness", () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog);

    for (const name of ["structured_ssh_auth", "structured_ssh_exec", "structured_ssh_copy_upload", "structured_ssh_copy_download"] as const) {
      expect(catalog.get(name)).toMatchObject({
        executor: "relay",
        impact: "high",
        exposure: "discoverable",
        requiresApproval: false,
        requiredCapabilities: ["use_remote_hosts"],
        relayCapabilities: name.startsWith("structured_ssh_copy_")
          ? ["canUseStructuredSsh", "canUseStructuredSshCopy"]
          : ["canUseStructuredSsh"],
      });
    }
    expect(catalog.get("structured_ssh_output")).toMatchObject({
      executor: "relay",
      impact: "read-only",
      requiresApproval: false,
      relayCapabilities: ["canReadStructuredSshOutput"],
    });
  });

  test("preserves progressive exposure and requires the dedicated available relay capability", () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    const requestedNames = expandToolFamilies(resolveIntentPacks(
      "use SSH to inspect the remote server",
    ).families);

    expect(requestedNames).toEqual(["structured_ssh_auth", "structured_ssh_exec", "structured_ssh_copy_upload", "structured_ssh_copy_download", "structured_ssh_output"]);
    expect(catalog.resolveProgressiveTools({
      relayCapabilities: { canUseStructuredSsh: true },
    }).snapshot.entries.map((entry) => entry.name)).not.toContain("structured_ssh_auth");
    expect(catalog.resolveProgressiveTools({
      intentPackToolNames: requestedNames,
      relayCapabilities: { use_remote_hosts: true },
    }).snapshot.entries.map((entry) => entry.name)).not.toContain("structured_ssh_auth");
    const exposedNames = catalog.resolveProgressiveTools({
      intentPackToolNames: requestedNames,
      relayCapabilities: { canUseStructuredSsh: true },
    }).snapshot.entries.map((entry) => entry.name);
    expect(exposedNames).toContain("structured_ssh_auth");
    expect(exposedNames).toContain("structured_ssh_exec");
    expect(exposedNames).not.toContain("structured_ssh_copy_upload");
    const copyExposedNames = catalog.resolveProgressiveTools({
      intentPackToolNames: requestedNames,
      relayCapabilities: { canUseStructuredSsh: true, canUseStructuredSshCopy: true },
    }).snapshot.entries.map((entry) => entry.name);
    expect(copyExposedNames).toContain("structured_ssh_copy_upload");
    expect(copyExposedNames).toContain("structured_ssh_copy_download");
    const outputOnlyNames = catalog.resolveProgressiveTools({
      intentPackToolNames: requestedNames,
      relayCapabilities: { canReadStructuredSshOutput: true },
    }).snapshot.entries.map((entry) => entry.name);
    expect(outputOnlyNames).toContain("structured_ssh_output");
    expect(outputOnlyNames).not.toContain("structured_ssh_exec");
    expect(resolveIntentPacks("run the local test suite").families).not.toContain("structured_ssh");
  });
});
