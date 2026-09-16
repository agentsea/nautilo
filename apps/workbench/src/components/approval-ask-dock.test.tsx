/**
 * Capability-scoped standing approval grain + verb-hint tests for ApprovalAskDock.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import type { ApprovalReplyVerb } from "@nautilo/types";
import type { ApprovalAskState } from "../adapters/runtime-contexts";

let happyWindow: Window;
const priorGlobals: Record<string, unknown> = {};

const submitted: ApprovalReplyVerb[] = [];
let askState: ApprovalAskState;

function makeState(overrides: Partial<ApprovalAskState> = {}): ApprovalAskState {
  return {
    show: true,
    approvalId: "ap-cap-1",
    tools: [{ name: "test_control_action", args: { x: 10, y: 20 } }],
    reason: "test control needs approval",
    reasonCode: "destructive-tool",
    network: null,
    allowedVerbs: ["once", "room", "always", "deny"],
    scopeInfo: [
      {
        onceDisplay: "test_control_action(x: 10, y: 20)",
        generalizedDisplay: "capability: control_desktop",
        sameAsOnce: false,
        approvalKind: "capability",
        capabilitySlug: "control_desktop",
      },
    ],
    localMcpInstall: null,
    mediaGeneration: null,
    structuredSsh: null,
    requiresExplicitReview: false,
    error: null,
    submitting: false,
    ...overrides,
  };
}

let ApprovalAskDock: (typeof import("./approval-ask-dock"))["ApprovalAskDock"];

beforeAll(async () => {
  happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
  for (const k of ["window", "document", "navigator", "HTMLElement"] as const) {
    priorGlobals[k] = (globalThis as Record<string, unknown>)[k];
  }
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
  });

  mock.module("../adapters/runtime-contexts", () => ({
    useApprovalAsk: () => ({
      state: askState,
      submit: async (verb: ApprovalReplyVerb) => {
        submitted.push(verb);
      },
    }),
  }));

  ({ ApprovalAskDock } = await import("./approval-ask-dock"));
});

beforeEach(() => {
  submitted.length = 0;
  askState = makeState();
});

afterAll(async () => {
  await new Promise<void>((r) => setTimeout(r, 50));
  mock.restore();
  const g = globalThis as Record<string, unknown>;
  for (const key of Object.keys(priorGlobals)) {
    if (priorGlobals[key] === undefined) delete g[key];
    else g[key] = priorGlobals[key];
  }
});

async function flush(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0));
}

describe("ApprovalAskDock (capability scope)", () => {
  test("redacts sensitive tool arguments from text and title attributes", async () => {
    askState = makeState({
      tools: [{
        name: "edit-open-design",
        args: {
          operation: "connector-update",
          sessionToken: "dock-session-secret",
          request: { headers: { Authorization: "Bearer dock-secret" } },
        },
      }],
      scopeInfo: [],
    });
    const original = structuredClone(askState.tools[0]!.args);
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    root.render(<ApprovalAskDock />);
    await flush();

    expect(host.textContent).toContain("operation: connector-update");
    expect(host.innerHTML).toContain("[redacted]");
    expect(host.innerHTML).not.toContain("dock-session-secret");
    expect(host.innerHTML).not.toContain("dock-secret");
    expect(host.querySelector("[title]")?.getAttribute("title")).not.toContain("dock-session-secret");
    expect(askState.tools[0]!.args).toEqual(original);

    root.unmount();
    host.remove();
    await flush();
  });

  test("renders capability grain instead of exact-command copy", async () => {
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root: Root = createRoot(host as unknown as HTMLElement);
    root.render(<ApprovalAskDock />);
    await flush();

    const grain = host.querySelector('[data-testid="approval-grain"]');
    expect(grain?.textContent).toContain("capability: control_desktop");
    expect(grain?.textContent).not.toContain("exactly this command");

    root.unmount();
    host.remove();
    await flush();
  });

  test("renders truthful operation copy without exposing the internal reason code", async () => {
    askState = makeState({
      tools: [{ name: "run_shell", args: { command: "pwd" } }],
      reason: "Shell execution — needs approval",
      reasonCode: "destructive-tool",
    });
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    root.render(<ApprovalAskDock />);
    await flush();

    expect(host.textContent).toContain("Shell execution — needs approval");
    expect(host.textContent).not.toContain("destructive-tool");
    expect(host.textContent).not.toContain("destructive-low");

    root.unmount();
    host.remove();
    await flush();
  });

  test("renders a long run_shell reason as an untruncated typed approval field", async () => {
    const reason = "full integration suite must finish before we can diagnose the failing macOS signing stage";
    askState = makeState({
      tools: [{
        name: "run_shell",
        args: { command: "bun test", timeout_seconds: 3600 },
        runShellTimeout: { timeoutSeconds: 3600, reason },
      }],
      scopeInfo: [],
    });
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    root.render(<ApprovalAskDock />);
    await flush();

    const detail = host.querySelector('[data-testid="run-shell-timeout-approval"]');
    expect(detail?.textContent).toContain("Long command budget: 3600 seconds");
    expect(detail?.textContent).toContain(reason);
    expect(detail?.className).not.toContain("truncate");

    root.unmount();
    host.remove();
    await flush();
  });

  test("capability-scoped room/always buttons use capability-aware tooltips", async () => {
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    root.render(<ApprovalAskDock />);
    await flush();

    const room = host.querySelector('[data-verb="room"]') as HTMLButtonElement | null;
    const always = host.querySelector('[data-verb="always"]') as HTMLButtonElement | null;
    expect(room?.title).toContain("capability");
    expect(always?.title).toContain("capability");
    expect(room?.title).not.toContain("matching calls");

    root.unmount();
    host.remove();
    await flush();
  });

  test("renders the dedicated exact-effect local MCP preview and only once/deny", async () => {
    askState = makeState({
      allowedVerbs: ["once", "deny"],
      requiresExplicitReview: true,
      localMcpInstall: {
        version: "local-mcp-install-v1",
        digest: "digest-123",
        preview: {
          version: "local-mcp-install-v1",
          human: "Writer",
          machine: "Writer Mac",
          relayId: "relay-1",
          name: "github-mcp",
          transport: { kind: "stdio", command: "npx", args: ["-y", "@scope/github@1.2.3"] },
          source: { label: "Official docs", url: "https://example.test/docs" },
          package: { name: "@scope/github", version: "1.2.3" },
          mayDownloadOnFirstRun: true,
          unpinnedPackage: false,
          environment: [{ name: "GITHUB_TOKEN", present: true }],
          availabilitySummary: "Personal — only you can use tools from this MCP.",
          subprocessSandboxed: false,
          digest: "digest-123",
        },
      },
    });
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    root.render(<ApprovalAskDock />);
    await flush();
    expect(host.querySelector('[data-testid="local-mcp-install-approval"]')?.textContent).toContain("Exact argv");
    expect(host.querySelector('[data-testid="local-mcp-install-approval"]')?.textContent).toContain("Relay ID: relay-1");
    expect(host.querySelector('[data-verb="room"]')).toBeNull();
    expect(host.querySelector('[data-verb="always"]')).toBeNull();
    expect(host.textContent).toContain('argv[1]="-y"');
    expect(host.textContent).toContain('argv[2]="@scope/github@1.2.3"');
    expect(host.textContent).toContain("Approval digest: digest-123");
    expect(host.textContent).toContain("not sandboxed");
    root.unmount();
    host.remove();
  });

  test("states that streamable HTTP launches no local subprocess", async () => {
    askState = makeState({
      allowedVerbs: ["once", "deny"],
      requiresExplicitReview: true,
      localMcpInstall: {
        version: "local-mcp-install-v1",
        digest: "http-digest",
        preview: {
          version: "local-mcp-install-v1",
          human: "Writer",
          machine: "Writer Mac",
          relayId: "relay-1",
          name: "http-mcp",
          transport: { kind: "streamable-http", url: "https://example.test/mcp" },
          source: { label: "Official docs", url: "https://example.test/" },
          package: null,
          mayDownloadOnFirstRun: false,
          unpinnedPackage: false,
          environment: [],
          availabilitySummary: "Personal — only you can use tools from this MCP.",
          subprocessSandboxed: null,
          digest: "http-digest",
        },
      },
    });
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    root.render(<ApprovalAskDock />);
    await flush();
    expect(host.textContent).toContain("No local subprocess is launched for this HTTP MCP.");
    expect(host.textContent).not.toContain("subprocess is not sandboxed");
    root.unmount();
    host.remove();
  });

  test("renders the dedicated structured SSH summary and only once/deny", async () => {
    askState = makeState({
      allowedVerbs: ["once", "deny"],
      requiresExplicitReview: true,
      structuredSsh: {
        version: "structured-ssh-v1",
        toolCallId: "tool-call-1",
        approvedRequestDigest: "a".repeat(64),
        preparationId: "ssh-preparation-1",
        operation: "exec",
        host: "build.example.test",
        port: 22,
        remoteUser: "deploy",
        hostKeyFingerprint: "SHA256:host-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        hostTrust: "trusted",
        program: "printf",
        argv: ["hello"],
        timeoutSeconds: 7_200,
        timeoutReason: "Database migration and verification",
      },
    });
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root: Root = createRoot(host as unknown as HTMLElement);
    root.render(<ApprovalAskDock />);
    await flush();
    const detail = host.querySelector('[data-testid="structured-ssh-approval"]');
    expect(detail?.textContent).toContain("build.example.test:22");
    expect(detail?.textContent).toContain("Remote user: deploy");
    expect(detail?.textContent).toContain('program="printf"');
    expect(detail?.textContent).toContain("Execution budget: 7200 seconds");
    expect(detail?.textContent).toContain("Database migration and verification");
    expect(detail?.textContent).toContain("Host trust: Already trusted");
    expect(host.querySelector('[data-verb="room"]')).toBeNull();
    expect(host.querySelector('[data-verb="always"]')).toBeNull();
    root.unmount();
    host.remove();
  });

  test("renders an accessible paid media quote, leaks no topology, and supports keyboard approval", async () => {
    askState = makeState({
      tools: [{
        name: "generate_video",
        args: {
          providerUrl: "https://provider.example/private",
          receiptId: "mg_private_receipt_1234",
          rawBody: "provider raw response",
        },
      }],
      allowedVerbs: ["once", "deny"],
      requiresExplicitReview: true,
      mediaGeneration: {
        version: "media-generation-approval-v1",
        digest: "a".repeat(64),
        quoteDigest: "b".repeat(64),
        revision: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
        preview: {
          mediaKind: "video",
          model: "seedance-2-5-text-to-video-basic",
          settings: {
            durationSeconds: 5,
            aspectRatio: "16:9",
            resolution: "720p",
            audio: true,
          },
          prompt: {
            characterCount: 842,
            summary: "A nautilus glides through a luminous underwater city",
            truncated: true,
          },
          quote: { currency: "USD", amountMicros: 1_250_000, display: "USD 1.250000" },
          spendNotice: "Approving starts a paid generation using this exact quote.",
        },
      } as NonNullable<ApprovalAskState["mediaGeneration"]>,
    });
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    root.render(<ApprovalAskDock />);
    await flush();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const detail = host.querySelector('[data-testid="media-generation-approval"]');
    expect(detail?.getAttribute("aria-label")).toBe("Paid video generation");
    expect(detail?.querySelector("details")?.hasAttribute("open")).toBe(false);
    expect(detail?.querySelector('[data-testid="media-generation-quote"]')?.textContent).toBe("$1.25");
    expect(detail?.textContent).toContain("Paid video generation");
    expect(detail?.textContent).toContain("Seedance 2.5 · Simple text");
    expect(detail?.textContent).toContain("842 characters, summary shown");
    expect(detail?.textContent).toContain("Duration5 seconds");
    expect(detail?.textContent).toContain("USD 1.250000");
    expect(detail?.textContent).toContain("Approving starts paid generation");
    expect(host.querySelector('[data-verb="room"]')).toBeNull();
    expect(host.querySelector('[data-verb="always"]')).toBeNull();
    expect(host.textContent).not.toContain("provider.example");
    expect(host.textContent).not.toContain("mg_private_receipt");
    expect(host.textContent).not.toContain("provider raw response");

    happyWindow.dispatchEvent(new happyWindow.KeyboardEvent("keydown", { key: "Enter" }));
    await flush();
    expect(submitted).toEqual(["once"]);
    root.unmount();
    host.remove();
  });

  test("renders both exact endpoints for structured SSH copy approval", async () => {
    askState = makeState({
      allowedVerbs: ["once", "deny"],
      requiresExplicitReview: true,
      structuredSsh: {
        version: "structured-ssh-v1",
        toolCallId: "tool-call-copy",
        approvedRequestDigest: "b".repeat(64),
        preparationId: "ssh-preparation-copy",
        operation: "copy-upload",
        host: "build.example.test",
        port: 22,
        remoteUser: "deploy",
        hostKeyFingerprint: "SHA256:host-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        hostTrust: "unknown",
        localPath: "/Users/developer/Nautilo Workspace/release.tar",
        remotePath: "/tmp/release.tar",
      },
    });
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root: Root = createRoot(host as unknown as HTMLElement);
    root.render(<ApprovalAskDock />);
    await flush();
    const detail = host.querySelector('[data-testid="structured-ssh-approval"]');
    expect(detail?.textContent).toContain('localPath="/Users/developer/Nautilo Workspace/release.tar"');
    expect(detail?.textContent).toContain('remotePath="/tmp/release.tar"');
    expect(detail?.textContent).not.toContain("Authentication only");
    root.unmount();
    host.remove();
  });

  test("renders an ordered Advanced Seedance reference review", async () => {
    askState = makeState({
      allowedVerbs: ["once", "deny"],
      requiresExplicitReview: true,
      mediaGeneration: {
        version: "media-generation-approval-v1",
        digest: "a".repeat(64),
        quoteDigest: "b".repeat(64),
        revision: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
        preview: {
          mediaKind: "video",
          model: "seedance-2-5-reference-to-video-basic",
          settings: { durationSeconds: 10, aspectRatio: "16:9", resolution: "720p", audio: true, referenceImages: 2, referenceAudios: 1, referenceAudioSeconds: 2.75 },
          referenceImages: [
            { index: 1, artifactId: "workspace-noir", label: "jeannie-noir.png" },
            { index: 2, artifactId: "workspace-light", label: "neon-light.png" },
          ],
          referenceAudios: [{ index: 1, artifactId: "workspace-voice", label: "voice-guide.wav", durationSeconds: 2.75 }],
          prompt: { characterCount: 40, summary: "Use <Image 1> and <Image 2>.", truncated: false },
          quote: { currency: "USD", amountMicros: 1_440_000, display: "USD 1.440000" },
          spendNotice: "Approving starts a paid generation using this exact quote.",
        },
      },
    });
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    root.render(<ApprovalAskDock />);
    await flush();
    expect(host.textContent).toContain("Seedance 2.5 · Advanced reference");
    expect(host.textContent).toContain("<Image 1>jeannie-noir.png");
    expect(host.textContent).toContain("<Image 2>neon-light.png");
    expect(host.textContent).toContain("Audio references");
    expect(host.textContent).toContain("<Audio 1> voice-guide.wav · 2.75s");
    expect(host.textContent).toContain("may reject references containing people");
    expect(host.querySelectorAll('[data-testid="media-generation-reference-list"] li')).toHaveLength(3);
    root.unmount();
    host.remove();
  });

  test("fails closed visibly when exact-review details are unavailable", async () => {
    askState = makeState({
      allowedVerbs: [],
      requiresExplicitReview: true,
      localMcpInstall: null,
      tools: [],
    });
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root: Root = createRoot(host as unknown as HTMLElement);
    root.render(<ApprovalAskDock />);
    await flush();
    expect(host.textContent).toContain("Exact review details are unavailable");
    expect(host.querySelector("button")).toBeNull();
    root.unmount();
    host.remove();
  });

  test("fails closed on a malformed paid-media preview", async () => {
    askState = makeState({
      allowedVerbs: ["once", "deny"],
      requiresExplicitReview: true,
      mediaGeneration: {
        version: "media-generation-approval-v1",
        digest: "forged",
        providerUrl: "https://provider.example/private",
      } as unknown as NonNullable<ApprovalAskState["mediaGeneration"]>,
    });
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    root.render(<ApprovalAskDock />);
    await flush();
    expect(host.textContent).toContain("Exact review details are unavailable");
    expect(host.querySelector('[data-verb="once"]')).toBeNull();
    expect(host.querySelector('[data-verb="room"]')).toBeNull();
    expect(host.querySelector('[data-verb="always"]')).toBeNull();
    expect(host.querySelector('[data-verb="deny"]')).not.toBeNull();
    expect(host.textContent).not.toContain("provider.example");
    root.unmount();
    host.remove();
  });

  test("makes an expired sharing projection deny-only, including keyboard submit", async () => {
    askState = makeState({
      allowedVerbs: ["once", "deny"],
      tools: [{
        name: "share_memory",
        args: {},
        shareMemoryPreview: {
          memoryContentSnippet: "snippet",
          memoryType: null,
          targetHandle: "alice",
          targetDisplayName: "Alice",
          roomLabel: "Shared",
          wouldCreate: false,
          sensitivity: "sensitive",
          projection: {
            mode: "project",
            expiresAt: Date.now() + 20,
            content: "exact content",
            roomLabel: "Shared",
            roomKind: "private",
            memberCount: 2,
            audienceWarning: "Alice can read this.",
          },
        },
      }],
    });
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    root.render(<ApprovalAskDock />);
    await flush();
    await new Promise<void>((resolve) => setTimeout(resolve, 35));
    expect(host.textContent).toContain("This sharing preview has expired. Deny it and ask for a fresh preview.");
    expect(host.querySelector('[data-verb="once"]')).toBeNull();
    expect(host.querySelector('[data-verb="deny"]')).not.toBeNull();
    happyWindow.dispatchEvent(new happyWindow.KeyboardEvent("keydown", { key: "Enter" }));
    expect(submitted).toEqual([]);

    const preview = askState.tools[0]?.shareMemoryPreview;
    if (!preview?.projection) throw new Error("projection missing");
    const { expiresAt: _expiresAt, ...legacyProjection } = preview.projection;
    askState = makeState({
      allowedVerbs: ["once", "deny"],
      tools: [{
        name: "share_memory",
        args: {},
        shareMemoryPreview: { ...preview, projection: legacyProjection },
      }],
    });
    root.render(<ApprovalAskDock />);
    await flush();
    expect(host.textContent).not.toContain("This sharing preview has expired");
    expect(host.querySelector('[data-verb="once"]')).not.toBeNull();
    root.unmount();
    host.remove();
  });
});
