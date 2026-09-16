/**
 * D103 P4.1 / M161 Phase 1 — renderer webPreferences parity test.
 *
 * Static-analysis test: read every renderer-bearing BrowserWindow and
 * WebContentsView constructor and assert webPreferences match the locked-in
 * defaults from `apps/desktop/PRODUCTION.md` §6. The M161 main host is a
 * renderer-less BaseWindow; its active WebContentsView owns the preferences.
 *
 * The test parses source files as text rather than running them — the
 * `electron` module is not importable under `bun:test` outside of an
 * Electron runtime. Static-text parsing is intentionally cheap, runs
 * in CI, and catches the failure mode this test exists to prevent:
 * a future change adding a window with `sandbox: false` or
 * `nodeIntegration: true` and slipping past code review.
 *
 * Locked-in defaults per PRODUCTION.md §6 threat model (every renderer):
 *   - nodeIntegration: false
 *   - contextIsolation: true
 *   - sandbox: true
 *   - no webSecurity: false
 *   - no allowRunningInsecureContent: true
 *   - no experimentalFeatures: true
 *
 * Preload is required for windows that expose IPC to the renderer
 * (active server view, first-run, onboarding). The auth window is a documented
 * exception: it has NO preload by design (defence-in-depth — the OIDC
 * origin is treated as untrusted and given no IPC surface to attack).
 * See `apps/desktop/electron/auth/auth-window.ts:75-83`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const desktopRoot = join(import.meta.dir, "../..");

const RENDERER_SOURCES = [
  {
    file: "electron/main.ts",
    constructorName: "BrowserWindow",
    expectedCount: 2,
    requirePreload: true,
  },
  {
    file: "electron/main.ts",
    constructorName: "WebContentsView",
    // M161 Phase 3 — two constructors: the boot `createWindow` view (one
    // per active session on the shared BaseWindow host) and the lazy
    // `createServerSessionView` used by in-process switch/add. Both use
    // the identical locked-in webPreferences below.
    expectedCount: 2,
    requirePreload: true,
  },
  {
    file: "electron/auth/auth-window.ts",
    constructorName: "BrowserWindow",
    expectedCount: 1,
    requirePreload: false,
  },
] as const;

function extractConstructorBlocks(
  source: string,
  constructorName: "BrowserWindow" | "WebContentsView",
): string[] {
  const pattern = new RegExp(
    `new ${constructorName}\\(\\{[\\s\\S]*?\\n\\s*\\}\\);?`,
    "g",
  );
  return source.match(pattern) ?? [];
}

describe("Electron renderer webPreferences parity (D103 P4.1 / M161)", () => {
  for (const {
    file,
    constructorName,
    expectedCount,
    requirePreload,
  } of RENDERER_SOURCES) {
    describe(`${file} ${constructorName}`, () => {
      const source = readFileSync(join(desktopRoot, file), "utf-8");
      const blocks = extractConstructorBlocks(source, constructorName);

      test(`finds exactly ${expectedCount} ${constructorName} constructor(s)`, () => {
        expect(blocks.length).toBe(expectedCount);
      });

      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i] ?? "";
        const label = `${constructorName} #${i + 1}`;

        test(`${label}: nodeIntegration:false`, () => {
          expect(block).toMatch(/nodeIntegration:\s*false/);
        });

        test(`${label}: contextIsolation:true`, () => {
          expect(block).toMatch(/contextIsolation:\s*true/);
        });

        test(`${label}: sandbox:true`, () => {
          expect(block).toMatch(/sandbox:\s*true/);
        });

        test(`${label}: no webSecurity:false`, () => {
          expect(block).not.toMatch(/webSecurity:\s*false/);
        });

        test(`${label}: no allowRunningInsecureContent:true`, () => {
          expect(block).not.toMatch(/allowRunningInsecureContent:\s*true/);
        });

        test(`${label}: no experimentalFeatures:true`, () => {
          expect(block).not.toMatch(/experimentalFeatures:\s*true/);
        });

        if (requirePreload) {
          test(`${label}: preload uses path.join(__dirname, ...)`, () => {
            expect(block).toMatch(/preload:\s*path\.join\(__dirname/);
          });
        }
      }
    });
  }

  test("total renderer-bearing constructor count matches §6 threat model", () => {
    const totalExpected = RENDERER_SOURCES.reduce(
      (sum, source) => sum + source.expectedCount,
      0,
    );
    let totalFound = 0;
    for (const { file, constructorName } of RENDERER_SOURCES) {
      const source = readFileSync(join(desktopRoot, file), "utf-8");
      totalFound += extractConstructorBlocks(source, constructorName).length;
    }
    expect(totalFound).toBe(totalExpected);
  });

  test("main process keeps the renderer host separate from the invisible initial-connection host", () => {
    const source = readFileSync(join(desktopRoot, "electron/main.ts"), "utf-8");
    // D514 keeps the normal renderer-bearing host and a separate, hidden host
    // used only while a first connection is being verified. The latter must
    // never become an extra renderer surface or outlive the picker flow.
    expect(source.match(/new BaseWindow\(\{/g) ?? []).toHaveLength(2);
    // M161 Phase 3 — two WebContentsView constructors (boot + lazy switch).
    expect(source.match(/new WebContentsView\(\{/g) ?? []).toHaveLength(2);
    expect(source).toContain("mainWindow.contentView.addChildView(view)");
    expect(source).toContain("activeSession.view = view");

    const initialHostStart = source.indexOf("function ensureInitialConnectionHost()");
    const initialHostEnd = source.indexOf("function showFirstRunPicker(", initialHostStart);
    expect(initialHostStart).toBeGreaterThan(-1);
    expect(initialHostEnd).toBeGreaterThan(initialHostStart);
    const initialHost = source.slice(initialHostStart, initialHostEnd);
    expect(initialHost).toContain("show: false");
    expect(initialHost).toContain("configureServerSessions()");
    expect(initialHost).toContain("initialConnectionHost?.destroy()");
    expect(initialHost).toContain("if (mainWindow === initialConnectionHost) mainWindow = null");
  });
});
