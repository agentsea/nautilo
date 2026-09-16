import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { BrowserResearchReadExecutor } from "../../electron/browser-research-read-executor";
import {
  BrowserPageSnapshotStore,
  type BrowserPageSnapshotOwnerBinding,
} from "../../electron/browser-page-snapshot-store";

const INVOCATION = { toolCallId: "tool-research-1", laneKey: "room:room-1" } as const;
const SNAPSHOT_OWNER: BrowserPageSnapshotOwnerBinding = {
  instanceId: "instance-1", userId: "user-1", relayId: "relay-1", desktopSessionId: "desktop-1",
};

describe("BrowserResearchReadExecutor", () => {
  test("returns a stable redacted page failure when the local lease cannot be created", async () => {
    const executor = new BrowserResearchReadExecutor({
      agentBrowserBin: "/agent-browser",
      pluginRuntimeBin: "/node",
      providerScriptPath: "/provider.js",
      targetManager: {
        createLease: async () => { throw new Error("local navigation detail must not cross the relay"); },
        getActiveLease: () => null,
        markChallenge: () => null,
        waitForDecision: async () => "cancel",
        prepareReobserve: async () => null,
        release: async () => false,
      },
      exec: async () => { throw new Error("agent-browser must not run without a lease"); },
    });

    const result = await executor.read({ url: "https://example.com/unavailable", ...INVOCATION });

    expect(result).toMatchObject({
      status: "ok",
      result: {
        quality: "error",
        failure: "navigation-error",
        content: "",
        diagnostics: ["navigation-error"],
      },
    });
  });

  test("returns and cleans a deferred challenge without opening an intervention", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "nautilo-research-test-"));
    const leaseId = "123e4567-e89b-12d3-a456-426614174099";
    let marked = 0;
    let released = 0;
    try {
      const snapshot = {
        leaseId,
        role: "research" as const,
        requestedUrl: "https://example.com/challenge",
        currentUrl: "https://example.com/challenge",
        partition: `nautilo-research-${leaseId}`,
        cdpUrl: "ws://127.0.0.1:1234/devtools/page/challenge",
        state: "agent_background" as const,
      };
      const executor = new BrowserResearchReadExecutor({
        temporaryRoot,
        agentBrowserBin: "/agent-browser",
        pluginRuntimeBin: "/node",
        providerScriptPath: "/provider.js",
        targetManager: {
          createLease: async () => snapshot,
          getActiveLease: () => snapshot,
          markChallenge: () => { marked += 1; return null; },
          waitForDecision: async () => "cancel",
          prepareReobserve: async () => null,
          release: async () => { released += 1; return true; },
        },
        exec: async (_bin, argv) => argv.at(-1) === "close"
          ? { stdout: "" }
          : { stdout: JSON.stringify({
              finalUrl: snapshot.currentUrl,
              title: "Verify you are human",
              readiness: "complete",
              extractionMs: 2,
              root: "main",
              blocks: [{ kind: "heading", text: "Human verification" }],
              totalCharacters: 18,
              totalCharactersCapped: false,
              metadataTruncated: false,
              iframeCount: 1,
              canvasCount: 0,
              virtualizedHint: false,
              boilerplateHint: false,
              challengeSignals: ["turnstile"],
              sourceTruncated: false,
            }) },
      });

      const result = await executor.read({
        url: snapshot.requestedUrl,
        challengeBehavior: "defer",
        ...INVOCATION,
      });
      expect(result).toMatchObject({ status: "ok", result: { challenge: { detected: true } } });
      expect(marked).toBe(0);
      expect(released).toBe(1);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("keeps the original call pending and freshly re-reads the exact lease after automatic clearance", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "nautilo-research-test-"));
    const leaseId = "123e4567-e89b-12d3-a456-426614174000";
    let releases = 0;
    let evalCount = 0;
    let interventionCount = 0;
    try {
      const snapshot = {
        leaseId,
        role: "research" as const,
        requestedUrl: "https://example.com/challenge",
        currentUrl: "https://example.com/challenge",
        partition: `nautilo-research-${leaseId}`,
        cdpUrl: "ws://127.0.0.1:1234/devtools/page/challenge",
        state: "agent_background" as const,
      };
      const executor = new BrowserResearchReadExecutor({
        temporaryRoot,
        agentBrowserBin: "/agent-browser",
        pluginRuntimeBin: "/node",
        providerScriptPath: "/provider.js",
        onIntervention: () => { interventionCount += 1; },
        targetManager: {
          createLease: async () => snapshot,
          getActiveLease: () => snapshot,
          markChallenge: (_leaseId, binding) => ({
            id: leaseId,
            ...binding,
            state: "awaiting_choice",
            host: "example.com",
            reason: "human-verification",
            expiresAt: "2026-08-07T22:00:00.000Z",
          }),
          waitForDecision: async () => "done",
          prepareReobserve: async () => ({ ...snapshot, state: "reobserve" }),
          release: async () => { releases += 1; return true; },
        },
        exec: async (_bin, argv) => {
          if (argv.at(-1) === "close") return { stdout: "" };
          if (argv.includes("snapshot")) return { stdout: JSON.stringify({ success: true, data: { snapshot: '- main "Readable article" [ref=e1]\n  - heading "Readable article" [ref=e2]' } }) };
          if (argv.includes("get") && argv.includes("html")) {
            return { stdout: JSON.stringify({
              success: true,
              data: { html: `<head><title>Readable article</title></head><body><article><h1>Readable article</h1><p>${"Readable evidence after Human verification. ".repeat(20)}</p></article></body>` },
              error: null,
            }) };
          }
          evalCount += 1;
          return { stdout: JSON.stringify({
              finalUrl: snapshot.currentUrl,
              title: evalCount === 1 ? "Verify you are human" : "Readable article",
              readiness: "complete",
              extractionMs: 2,
              root: "main",
              blocks: [{ kind: "heading", text: evalCount === 1 ? "Human verification" : "Readable article" }],
              totalCharacters: 18,
              totalCharactersCapped: false,
              metadataTruncated: false,
              iframeCount: evalCount === 1 ? 1 : 0,
              canvasCount: 0,
              virtualizedHint: false,
              boilerplateHint: false,
              challengeSignals: evalCount === 1 ? ["turnstile"] : [],
              sourceTruncated: false,
            }) };
        },
      });

      const result = await executor.read({ url: snapshot.requestedUrl, ...INVOCATION });
      expect(result).toMatchObject({ status: "ok", result: {
        title: "Readable article",
        challenge: { detected: false },
      } });
      expect(interventionCount).toBe(1);
      expect(evalCount).toBe(2);
      expect(releases).toBe(1);
      expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: temporaryRoot }))).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  for (const terminal of [
    ["alternate", "browser_research_alternate", "The Human requested another source."],
    ["cancel", "browser_research_cancelled", "The Human stopped browser research."],
    ["expired", "browser_research_expired", "The Human-verification handoff expired."],
  ] as const) {
    test(`returns the typed ${terminal[0]} outcome and clears the suspended lease`, async () => {
      const temporaryRoot = await mkdtemp(join(tmpdir(), "nautilo-research-test-"));
      const leaseId = "123e4567-e89b-12d3-a456-426614174111";
      let reobserved = 0;
      let released = 0;
      try {
        const snapshot = {
          leaseId,
          role: "research" as const,
          requestedUrl: "https://example.com/challenge",
          currentUrl: "https://example.com/challenge",
          partition: `nautilo-research-${leaseId}`,
          cdpUrl: "ws://127.0.0.1:1234/devtools/page/challenge",
          state: "agent_background" as const,
        };
        const executor = new BrowserResearchReadExecutor({
          temporaryRoot,
          agentBrowserBin: "/agent-browser",
          pluginRuntimeBin: "/node",
          providerScriptPath: "/provider.js",
          targetManager: {
            createLease: async () => snapshot,
            getActiveLease: () => snapshot,
            markChallenge: (_leaseId, binding) => ({
              id: leaseId,
              ...binding,
              state: "awaiting_choice",
              host: "example.com",
              reason: "human-verification",
              expiresAt: "2026-08-07T22:00:00.000Z",
            }),
            waitForDecision: async () => terminal[0],
            prepareReobserve: async () => {
              reobserved += 1;
              return null;
            },
            release: async () => {
              released += 1;
              return true;
            },
          },
          exec: async (_bin, argv) => {
            if (argv.at(-1) === "close") return { stdout: "" };
            return { stdout: JSON.stringify({
              finalUrl: snapshot.currentUrl,
              title: "Verify you are human",
              readiness: "complete",
              extractionMs: 2,
              root: "main",
              blocks: [{ kind: "heading", text: "Human verification" }],
              totalCharacters: 18,
              totalCharactersCapped: false,
              metadataTruncated: false,
              iframeCount: 1,
              canvasCount: 0,
              virtualizedHint: false,
              boilerplateHint: false,
              challengeSignals: ["turnstile"],
              sourceTruncated: false,
            }) };
          },
        });

        const result = await executor.read({ url: snapshot.requestedUrl, ...INVOCATION });
        expect(result).toEqual({
          status: "error",
          errorCode: terminal[1],
          error: terminal[2],
        });
        expect(reobserved).toBe(0);
        expect(released).toBe(1);
        expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: temporaryRoot }))).toEqual([]);
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    });
  }

  test("uses an isolated direct-page provider and cleans every lease artifact", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "nautilo-research-test-"));
    const execCalls: Array<{ argv: string[]; state?: unknown; config?: unknown }> = [];
    let active = true;
    let released: string | null = null;
    try {
      const executor = new BrowserResearchReadExecutor({
        temporaryRoot,
        agentBrowserBin: "/agent-browser",
        pluginRuntimeBin: "/node",
        providerScriptPath: "/provider.js",
        targetManager: {
          createLease: async () => ({
            leaseId: "lease-exact",
            role: "research",
            requestedUrl: "https://example.com/start",
            currentUrl: "https://example.com/final",
            partition: "nautilo-research-lease-exact",
            cdpUrl: "ws://127.0.0.1:1234/devtools/page/exact",
          }),
          getActiveLease: () =>
            active
              ? {
                  leaseId: "lease-exact",
                  role: "research",
                  requestedUrl: "https://example.com/start",
                  currentUrl: "https://example.com/final",
                  partition: "nautilo-research-lease-exact",
                  cdpUrl: "ws://127.0.0.1:1234/devtools/page/exact",
                }
              : null,
          markChallenge: () => null,
          waitForDecision: async () => "cancel",
          prepareReobserve: async () => null,
          release: async (leaseId) => {
            released = leaseId;
            active = false;
            return true;
          },
        },
        exec: async (_bin, argv) => {
          const configPath = argv[1];
          const config = JSON.parse(await readFile(configPath!, "utf8")) as {
            plugins: Array<{ args: string[] }>;
          };
          const state = JSON.parse(await readFile(config.plugins[0]!.args[2]!, "utf8"));
          execCalls.push({ argv, state, config });
          if (argv.at(-1) === "close") return { stdout: "" };
          return {
            stdout: JSON.stringify({
              success: true,
              data: {
                requestedUrl: "https://example.com/start",
                finalUrl: "https://example.com/final",
                title: "Example",
                content: "Useful content",
                totalChars: 14,
                extractionMethod: "dom-structured-text",
                extractionRoot: "main",
                readiness: "complete",
              },
            }),
          };
        },
      });

      const result = await executor.read({ url: "https://example.com/start", maxChars: 5000, ...INVOCATION });

      expect(result.status).toBe("ok");
      expect(released).toBe("lease-exact");
      expect(execCalls).toHaveLength(3);
      expect(execCalls[0]!.argv).toContain("eval");
      expect(execCalls[1]!.argv).toContain("snapshot");
      expect(execCalls[2]!.argv.at(-1)).toBe("close");
      expect(execCalls[0]!.state).toMatchObject({
        activeAppId: "lease-exact",
        views: [{ role: "research", leaseId: "lease-exact", visible: false }],
      });
      expect(execCalls[0]!.config).toMatchObject({ idleTimeout: "30s" });
      expect(JSON.stringify(execCalls[0]!.config)).not.toContain("browser-control-state.json");
      expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: temporaryRoot }))).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("returns canonical empty content for a no-document response without starting agent-browser", async () => {
    const lease = {
      leaseId: "lease-no-document",
      role: "research" as const,
      requestedUrl: "https://example.com/status/204",
      currentUrl: "https://example.com/status/204",
      partition: "nautilo-research-lease-no-document",
      cdpUrl: "ws://127.0.0.1:1234/devtools/page/no-document",
      documentState: "no-document" as const,
      state: "agent_background" as const,
    };
    let execCount = 0;
    let releaseCount = 0;
    const executor = new BrowserResearchReadExecutor({
      agentBrowserBin: "/agent-browser",
      pluginRuntimeBin: "/node",
      providerScriptPath: "/provider.js",
      targetManager: {
        createLease: async () => lease,
        getActiveLease: () => lease,
        markChallenge: () => null,
        waitForDecision: async () => "cancel",
        prepareReobserve: async () => null,
        release: async () => { releaseCount += 1; return true; },
      },
      exec: async () => {
        execCount += 1;
        throw new Error("agent-browser must not run for a no-document response");
      },
    });

    const result = await executor.read({ url: lease.requestedUrl, ...INVOCATION });

    expect(result).toMatchObject({
      status: "ok",
      result: {
        requestedUrl: lease.requestedUrl,
        finalUrl: lease.requestedUrl,
        content: "",
        totalCharacters: 0,
        eof: true,
        quality: "empty",
        failure: "empty-dom",
        diagnostics: ["no-readable-dom-content"],
      },
    });
    expect(execCount).toBe(0);
    expect(releaseCount).toBe(1);
  });

  test("clears a routine page cookie wall and re-reads the same lease without Human intervention", async () => {
    const lease = {
      leaseId: "lease-cookie-wall", role: "research" as const,
      requestedUrl: "https://example.com/article", currentUrl: "https://example.com/article",
      partition: "nautilo-research-cookie", cdpUrl: "ws://127.0.0.1:1234/devtools/page/cookie",
    };
    let cleared = false;
    let interventionCount = 0;
    let evalCount = 0;
    const executor = new BrowserResearchReadExecutor({
      agentBrowserBin: "/agent-browser", pluginRuntimeBin: "/node", providerScriptPath: "/provider.js",
      onIntervention: () => { interventionCount += 1; },
      targetManager: {
        createLease: async () => lease, getActiveLease: () => lease,
        markChallenge: () => null, waitForDecision: async () => "cancel", prepareReobserve: async () => null,
        release: async () => true,
      },
      exec: async (_bin, argv) => {
        if (argv.at(-1) === "close") return { stdout: "" };
        if (argv.includes("click")) { cleared = true; return { stdout: JSON.stringify({ success: true }) }; }
        if (argv.includes("wait")) return { stdout: JSON.stringify({ success: true }) };
        if (argv.includes("snapshot")) return { stdout: JSON.stringify({ success: true, data: { snapshot: cleared
          ? '- main "Article" [ref=e1]\n  - heading "Article" [ref=e2]'
          : '- dialog "Cookie consent privacy choices"\n  - button "Accept all" [ref=e1]\n  - button "Reject all" [ref=e2]' } }) };
        if (argv.includes("get") && argv.includes("html")) return { stdout: JSON.stringify({ success: true, data: { html: cleared
          ? `<head><title>Article</title></head><body><article><h1>Article</h1><p>${"Useful evidence. ".repeat(40)}</p></article></body>`
          : `<head><title>Article</title></head><body><article><h1>Article</h1><p>${"Useful evidence behind the overlay. ".repeat(260)}</p></article><div class="cookie-consent"><p>Cookie privacy choices</p><button>Reject all</button></div></body>` } }) };
        evalCount += 1;
        return { stdout: JSON.stringify({
          finalUrl: lease.currentUrl, title: "Article", readiness: "complete", extractionMs: 1, root: "main",
          blocks: cleared
            ? [{ kind: "paragraph", text: "Useful evidence" }]
            : [{ kind: "paragraph", text: `${"Useful evidence behind the overlay. ".repeat(260)} Cookie consent privacy choices Reject all` }],
          totalCharacters: cleared ? 40 : 9_500, totalCharactersCapped: false, metadataTruncated: false,
          iframeCount: 0, canvasCount: 0, virtualizedHint: false, boilerplateHint: false, challengeSignals: [], sourceTruncated: false,
        }) };
      },
    });

    const result = await executor.read({ url: lease.requestedUrl, ...INVOCATION });
    expect(result).toMatchObject({
      status: "ok",
      result: {
        title: "Article",
        content: expect.stringContaining("Useful evidence"),
        diagnostics: expect.arrayContaining(["consent-cleared-reject-optional"]),
      },
    });
    expect(cleared).toBe(true);
    expect(evalCount).toBe(2);
    expect(interventionCount).toBe(0);
  });

  test("returns a typed consent-wall outcome when one automatic action does not clear the page", async () => {
    const lease = {
      leaseId: "lease-stubborn-cookie-wall", role: "research" as const,
      requestedUrl: "https://example.com/consent", currentUrl: "https://example.com/consent",
      partition: "nautilo-research-stubborn-cookie", cdpUrl: "ws://127.0.0.1:1234/devtools/page/stubborn-cookie",
    };
    let clicks = 0;
    let releases = 0;
    let retained = false;
    const recovery = {
      reference: "r".repeat(43), expiresAt: "2026-08-10T12:00:00.000Z",
      requestedUrl: lease.requestedUrl, currentUrl: lease.currentUrl, cdpUrl: lease.cdpUrl, leaseId: lease.leaseId,
    };
    const executor = new BrowserResearchReadExecutor({
      agentBrowserBin: "/agent-browser", pluginRuntimeBin: "/node", providerScriptPath: "/provider.js",
      targetManager: {
        createLease: async () => lease, getActiveLease: () => lease,
        markChallenge: () => null, waitForDecision: async () => "cancel", prepareReobserve: async () => null,
        retainConsentRecovery: () => { retained = true; return recovery; },
        getConsentRecovery: (reference) => reference === recovery.reference ? recovery : null,
        recordConsentRecoveryScreenshot: () => true,
        release: async () => { releases += 1; return true; },
      },
      exec: async (_bin, argv) => {
        if (argv.at(-1) === "close") return { stdout: "" };
        if (argv.includes("click")) { clicks += 1; return { stdout: JSON.stringify({ success: true }) }; }
        if (argv.includes("snapshot")) return { stdout: JSON.stringify({ success: true, data: { snapshot: '- region "Cookie choices" [ref=e1]\n  - button "Reject cookies" [ref=e2]' } }) };
        if (argv.includes("get") && argv.includes("html")) return { stdout: JSON.stringify({ success: true, data: { html: '<main><div class="cookie-consent"><p>Cookie choices</p><button>Reject cookies</button></div></main>' } }) };
        return { stdout: JSON.stringify({
          finalUrl: lease.currentUrl, title: "Cookie choices", readiness: "complete", extractionMs: 1, root: "main",
          blocks: [{ kind: "paragraph", text: "Cookie choices Reject cookies" }], totalCharacters: 29,
          totalCharactersCapped: false, metadataTruncated: false, iframeCount: 0, canvasCount: 0,
          virtualizedHint: false, boilerplateHint: false, challengeSignals: [], sourceTruncated: false,
        }) };
      },
    });

    expect(await executor.read({ url: lease.requestedUrl, ...INVOCATION })).toMatchObject({
      status: "ok",
      result: {
        failure: "consent-wall",
        consentRecovery: { version: 1, reference: recovery.reference, expiresAt: recovery.expiresAt },
        diagnostics: expect.arrayContaining(["consent-attempted-reject-optional", "consent-wall-remained"]),
      },
    });
    expect(clicks).toBe(1);
    expect(retained).toBe(true);
    expect(releases).toBe(0);

    expect(await executor.recoverConsent({
      consentRecovery: { version: 1, reference: recovery.reference, operation: "snapshot" },
      ...INVOCATION,
    })).toMatchObject({
      status: "ok",
      result: {
        kind: "browser_research_consent_recovery",
        operation: "snapshot",
        reference: recovery.reference,
        state: "consent_wall",
        controls: [{ reference: "e2", label: "Reject cookies" }],
      },
    });
    expect(releases).toBe(0);
  });

  test("normalizes Retina consent screenshots to CSS pixels before returning multimodal evidence", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "nautilo-research-shot-test-"));
    const recovery = {
      reference: "r".repeat(43),
      expiresAt: "2026-08-10T12:00:00.000Z",
      requestedUrl: "https://example.com/consent",
      currentUrl: "https://example.com/consent",
      cdpUrl: "ws://127.0.0.1:1234/devtools/page/consent",
      leaseId: "lease-consent-screenshot",
    };
    const retinaPng = await sharp({
      create: {
        width: 2560,
        height: 1800,
        channels: 4,
        background: { r: 240, g: 240, b: 240, alpha: 1 },
      },
    }).png().toBuffer();
    let recorded: readonly number[] | null = null;
    try {
      const executor = new BrowserResearchReadExecutor({
        temporaryRoot,
        agentBrowserBin: "/agent-browser",
        pluginRuntimeBin: "/node",
        providerScriptPath: "/provider.js",
        normalizeScreenshot: async (bytes, width, height) => {
          const normalized = await sharp(bytes)
            .resize({ width, height, fit: "fill" })
            .png({ compressionLevel: 9 })
            .toBuffer({ resolveWithObject: true });
          return { data: normalized.data, width: normalized.info.width, height: normalized.info.height };
        },
        targetManager: {
          createLease: async () => { throw new Error("not used"); },
          getActiveLease: () => null,
          markChallenge: () => null,
          waitForDecision: async () => "cancel",
          prepareReobserve: async () => null,
          retainConsentRecovery: () => recovery,
          getConsentRecovery: (reference) => reference === recovery.reference ? recovery : null,
          recordConsentRecoveryScreenshot: (_reference, scale, width, height) => {
            recorded = [scale, width, height];
            return true;
          },
          release: async () => true,
        },
        exec: async (_bin, argv) => {
          if (argv.at(-1) === "close") return { stdout: "" };
          if (argv.includes("screenshot")) {
            await writeFile(argv.at(-1)!, retinaPng);
            return { stdout: "" };
          }
          return { stdout: JSON.stringify({ w: 1280, h: 900, dpr: 2 }) };
        },
      });

      const result = await executor.recoverConsent({
        consentRecovery: { version: 1, reference: recovery.reference, operation: "screenshot" },
        ...INVOCATION,
      });
      expect(result).toMatchObject({
        status: "ok",
        result: {
          viewport: { cssWidth: 1280, cssHeight: 900, imageWidth: 1280, imageHeight: 900, scale: 1 },
          image: { mime: "image/png" },
        },
      });
      expect(recorded).toEqual([1, 1280, 900]);
      const image = (result as { result: { image: { base64: string } } }).result.image;
      expect(Buffer.from(image.base64, "base64").byteLength).toBeLessThan(retinaPng.byteLength);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("does not mistake a readable page about cookies for a consent wall", async () => {
    const lease = {
      leaseId: "lease-cookie-article", role: "research" as const,
      requestedUrl: "https://example.com/cookie-news", currentUrl: "https://example.com/cookie-news",
      partition: "nautilo-research-cookie-article", cdpUrl: "ws://127.0.0.1:1234/devtools/page/cookie-article",
    };
    const executor = new BrowserResearchReadExecutor({
      agentBrowserBin: "/agent-browser", pluginRuntimeBin: "/node", providerScriptPath: "/provider.js",
      targetManager: {
        createLease: async () => lease, getActiveLease: () => lease,
        markChallenge: () => null, waitForDecision: async () => "cancel", prepareReobserve: async () => null,
        release: async () => true,
      },
      exec: async (_bin, argv) => {
        if (argv.at(-1) === "close") return { stdout: "" };
        if (argv.includes("snapshot")) return { stdout: JSON.stringify({ success: true, data: { snapshot: '- main "Cookie reporting" [ref=e1]\n  - heading "Cookies and tracking devices" [ref=e2]\n  - link "Read the recommendation" [ref=e3]' } }) };
        if (argv.includes("get") && argv.includes("html")) return { stdout: JSON.stringify({ success: true, data: { html: '<main><h1>Cookies and tracking devices</h1><p>Useful regulatory reporting.</p></main>' } }) };
        return { stdout: JSON.stringify({
          finalUrl: lease.currentUrl, title: "Cookies and tracking devices", readiness: "complete", extractionMs: 1, root: "main",
          blocks: [{ kind: "heading", text: "Cookies and tracking devices" }, { kind: "paragraph", text: "Useful regulatory reporting." }],
          totalCharacters: 60, totalCharactersCapped: false, metadataTruncated: false, iframeCount: 0, canvasCount: 0,
          virtualizedHint: false, boilerplateHint: false, challengeSignals: [], sourceTruncated: false,
        }) };
      },
    });

    expect(await executor.read({ url: lease.requestedUrl, ...INVOCATION })).toMatchObject({
      status: "ok",
      result: { title: "Cookies and tracking devices", content: expect.stringContaining("Cookies and tracking devices"), failure: "none" },
    });
  });

  test("replays Genie-selected consent labels in order before reading the page", async () => {
    const lease = {
      leaseId: "lease-consent-replay", role: "research" as const,
      requestedUrl: "https://example.com/article", currentUrl: "https://example.com/article",
      partition: "nautilo-research-consent-replay", cdpUrl: "ws://127.0.0.1:1234/devtools/page/consent-replay",
    };
    let step = 0;
    const replayCalls: string[][] = [];
    const executor = new BrowserResearchReadExecutor({
      agentBrowserBin: "/agent-browser", pluginRuntimeBin: "/node", providerScriptPath: "/provider.js",
      targetManager: {
        createLease: async () => lease, getActiveLease: () => lease,
        markChallenge: () => null, waitForDecision: async () => "cancel", prepareReobserve: async () => null,
        release: async () => true,
      },
      exec: async (_bin, argv) => {
        replayCalls.push(argv);
        if (argv.at(-1) === "close") return { stdout: "" };
        if (argv.includes("click")) { step += 1; return { stdout: JSON.stringify({ success: true }) }; }
        if (argv.includes("snapshot")) {
          const snapshot = step === 0
            ? '- region "Cookie consent" [ref=e1]\n  - button "Privacy, but make it minimal" [ref=e2]'
            : step === 1
              ? '- region "Cookie consent" [ref=e1]\n  - button "Save these choices" [ref=e2]'
              : '- main [ref=e1]\n  - heading "Article" [ref=e2]';
          return { stdout: JSON.stringify({ success: true, data: { snapshot } }) };
        }
        if (argv.includes("get") && argv.includes("html")) return { stdout: JSON.stringify({ success: true, data: { html: '<main><article><h1>Article</h1><p>Useful evidence.</p></article></main>' } }) };
        return { stdout: JSON.stringify({
          finalUrl: lease.currentUrl, title: "Article", readiness: "complete", extractionMs: 1, root: "article",
          blocks: [{ kind: "heading", text: "Article" }, { kind: "paragraph", text: "Useful evidence." }],
          totalCharacters: 24, totalCharactersCapped: false, metadataTruncated: false, iframeCount: 0,
          canvasCount: 0, virtualizedHint: false, boilerplateHint: false, challengeSignals: [], sourceTruncated: false,
        }) };
      },
    });
    const result = await executor.read({
      url: lease.requestedUrl,
      consentActions: ["Privacy, but make it minimal", "Save these choices"],
      ...INVOCATION,
    });
    expect(replayCalls.filter((argv) => argv.includes("click"))).toHaveLength(2);
    expect(result).toMatchObject({ status: "ok", result: { title: "Article", failure: "none" } });
    expect(step).toBe(2);
  });

  test("releases the research lease after retaining the initial immutable snapshot", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "nautilo-research-test-"));
    const store = new BrowserPageSnapshotStore();
    let released = 0;
    try {
      const lease = {
        leaseId: "lease-snapshot", role: "research" as const,
        requestedUrl: "https://example.com/article", currentUrl: "https://example.com/article",
        partition: "nautilo-research-lease-snapshot", cdpUrl: "ws://127.0.0.1:1234/devtools/page/snapshot",
      };
      const executor = new BrowserResearchReadExecutor({
        temporaryRoot,
        agentBrowserBin: "/agent-browser",
        pluginRuntimeBin: "/node",
        providerScriptPath: "/provider.js",
        snapshotStore: store,
        snapshotOwner: SNAPSHOT_OWNER,
        targetManager: {
          createLease: async () => lease,
          getActiveLease: () => lease,
          markChallenge: () => null,
          waitForDecision: async () => "cancel",
          prepareReobserve: async () => null,
          release: async () => { released += 1; return true; },
        },
        exec: async (_bin, argv) => {
          if (argv.at(-1) === "close") return { stdout: "" };
          if (argv.includes("get") && argv.includes("html")) {
            return { stdout: JSON.stringify({ success: true, data: { html: `<head><title>Long</title></head><body><article><p>${"Research snapshot evidence ".repeat(2_000)}</p></article></body>` } }) };
          }
          return { stdout: JSON.stringify({
            finalUrl: lease.currentUrl, title: "Long", readiness: "complete", extractionMs: 1, root: "article",
            blocks: [], totalCharacters: 0, totalCharactersCapped: false, metadataTruncated: false,
            iframeCount: 0, canvasCount: 0, virtualizedHint: false, boilerplateHint: false,
            challengeSignals: [], sourceTruncated: false,
          }) };
        },
      });
      const result = await executor.read({ url: lease.requestedUrl, ...INVOCATION });
      expect(result.status).toBe("ok");
      const first = result.result as {
        continuation?: { reference: string; nextOffsetCharacters: number };
        pageReference?: { reference: string };
      };
      expect(first.continuation).toBeDefined();
      expect(first.pageReference).toBeUndefined();
      expect(released).toBe(1);
      expect(store.debugState().entries).toBe(1);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("propagates the v13 snapshot-reference publication gate into background page reading", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "nautilo-research-test-"));
    const store = new BrowserPageSnapshotStore();
    try {
      const lease = {
        leaseId: "lease-v13", role: "research" as const,
        requestedUrl: "https://example.com/article", currentUrl: "https://example.com/article",
        partition: "nautilo-research-lease-v13", cdpUrl: "ws://127.0.0.1:1234/devtools/page/v13",
      };
      const executor = new BrowserResearchReadExecutor({
        temporaryRoot,
        agentBrowserBin: "/agent-browser",
        pluginRuntimeBin: "/node",
        providerScriptPath: "/provider.js",
        snapshotStore: store,
        snapshotOwner: SNAPSHOT_OWNER,
        publishSnapshotReference: true,
        targetManager: {
          createLease: async () => lease,
          getActiveLease: () => lease,
          markChallenge: () => null,
          waitForDecision: async () => "cancel",
          prepareReobserve: async () => null,
          release: async () => true,
        },
        exec: async (_bin, argv) => {
          if (argv.at(-1) === "close") return { stdout: "" };
          if (argv.includes("get") && argv.includes("html")) {
            return { stdout: JSON.stringify({ success: true, data: { html: `<head><title>Long</title></head><body><article><p>${"Research snapshot evidence ".repeat(2_000)}</p></article></body>` } }) };
          }
          return { stdout: JSON.stringify({
            finalUrl: lease.currentUrl, title: "Long", readiness: "complete", extractionMs: 1, root: "article",
            blocks: [], totalCharacters: 0, totalCharactersCapped: false, metadataTruncated: false,
            iframeCount: 0, canvasCount: 0, virtualizedHint: false, boilerplateHint: false,
            challengeSignals: [], sourceTruncated: false,
          }) };
        },
      });
      const result = await executor.read({ url: lease.requestedUrl, ...INVOCATION });
      expect(result.status).toBe("ok");
      const published = result.result as {
        continuation: { reference: string; expiresAt: string };
        pageReference: { reference: string; expiresAt: string };
      };
      expect(typeof published.continuation.reference).toBe("string");
      expect(typeof published.pageReference.reference).toBe("string");
      expect(published.pageReference).toEqual({
        version: 1,
        reference: published.continuation.reference,
        expiresAt: published.continuation.expiresAt,
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("releases the exact lease when evaluation fails", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "nautilo-research-test-"));
    let releaseCount = 0;
    try {
      const executor = new BrowserResearchReadExecutor({
        temporaryRoot,
        agentBrowserBin: "/agent-browser",
        pluginRuntimeBin: "/node",
        providerScriptPath: "/provider.js",
        targetManager: {
          createLease: async () => ({
            leaseId: "lease-failure",
            role: "research",
            requestedUrl: "https://example.com/",
            currentUrl: "https://example.com/",
            partition: "nautilo-research-lease-failure",
            cdpUrl: "ws://127.0.0.1:1234/devtools/page/failure",
          }),
          getActiveLease: () => ({
            leaseId: "lease-failure",
            role: "research",
            requestedUrl: "https://example.com/",
            currentUrl: "https://example.com/",
            partition: "nautilo-research-lease-failure",
            cdpUrl: "ws://127.0.0.1:1234/devtools/page/failure",
          }),
          markChallenge: () => null,
          waitForDecision: async () => "cancel",
          prepareReobserve: async () => null,
          release: async () => {
            releaseCount += 1;
            return true;
          },
        },
        exec: async (_bin, argv) => {
          if (argv.at(-1) === "close") return { stdout: "" };
          throw new Error("evaluation failed");
        },
      });

      const result = await executor.read({ url: "https://example.com/", ...INVOCATION });
      expect(result).toMatchObject({ status: "ok", result: { failure: "evaluation-error" } });
      expect(releaseCount).toBe(1);
      expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: temporaryRoot }))).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("threads cancellation into agent-browser and still closes the exact lease", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "nautilo-research-test-"));
    const controller = new AbortController();
    let released: string | null = null;
    try {
      const executor = new BrowserResearchReadExecutor({
        temporaryRoot,
        agentBrowserBin: "/agent-browser",
        pluginRuntimeBin: "/node",
        providerScriptPath: "/provider.js",
        targetManager: {
          createLease: async () => ({
            leaseId: "lease-cancelled",
            role: "research",
            requestedUrl: "https://example.com/",
            currentUrl: "https://example.com/",
            partition: "nautilo-research-lease-cancelled",
            cdpUrl: "ws://127.0.0.1:1234/devtools/page/cancelled",
          }),
          getActiveLease: () => ({
            leaseId: "lease-cancelled",
            role: "research",
            requestedUrl: "https://example.com/",
            currentUrl: "https://example.com/",
            partition: "nautilo-research-lease-cancelled",
            cdpUrl: "ws://127.0.0.1:1234/devtools/page/cancelled",
          }),
          markChallenge: () => null,
          waitForDecision: async () => "cancel",
          prepareReobserve: async () => null,
          release: async (leaseId) => {
            released = leaseId;
            return true;
          },
        },
        exec: async (_bin, argv, options) => {
          if (argv.at(-1) === "close") return { stdout: "" };
          expect(options.signal).toBe(controller.signal);
          controller.abort();
          throw new Error("aborted");
        },
      });

      const result = await executor.read({ url: "https://example.com/", ...INVOCATION }, controller.signal);
      expect(result).toMatchObject({ status: "ok", result: { failure: "evaluation-error" } });
      expect(released).toBe("lease-cancelled");
      expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: temporaryRoot }))).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
