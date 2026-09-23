/**
 * connectivity-related preflight must never call `app.quit()`.
 *
 * We pin this with (1) a static slice of `main.ts` between explicit
 * named markers where `app.quit()` is forbidden, and (2) a pure helper
 * mirroring `bootstrap.html` health classification for the four bad-boot
 * shapes.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const desktopRoot = join(import.meta.dir, "../..");
const mainSource = readFileSync(join(desktopRoot, "electron/main.ts"), "utf8");

type ShellStateOnBoot = "live" | "disconnected" | "wrong-server" | "no-pairing";

function fingerprintFromHealthJson(j: Record<string, unknown> | null): string | null {
  if (!j) return null;
  const sid = j["serverIdentity"];
  if (typeof sid === "string" && sid.length > 0) return sid;
  const a = j["logtoDesktopAppId"];
  const b = j["logtoResource"];
  if (
    typeof a === "string" &&
    a.length > 0 &&
    typeof b === "string" &&
    b.length > 0
  ) {
    return `${a}|${b}`;
  }
  return null;
}

function classifyBootstrap(args: {
  hasServerUrl: boolean;
  fetchOk: boolean;
  fetchJson: Record<string, unknown> | null;
  fetchThrew: boolean;
  pairedServerIdentity: string | null;
}): ShellStateOnBoot {
  if (!args.hasServerUrl) return "no-pairing";
  if (args.fetchThrew || !args.fetchOk) return "disconnected";
  const j = args.fetchJson;
  if (!j || typeof j["status"] !== "string") return "disconnected";
  const fp = fingerprintFromHealthJson(j);
  if (fp === null) return "disconnected";
  const expected = args.pairedServerIdentity;
  if (expected && expected !== fp) return "wrong-server";
  return "live";
}

describe("no app.quit in connect-bootstrap preflight region", () => {
  test("main.ts preflight slice contains zero app.quit()", () => {
    const start = mainSource.indexOf("// <connect-bootstrap-preflight>");
    const end = mainSource.indexOf("// </connect-bootstrap-preflight>");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const slice = mainSource.slice(start, end);
    expect(slice).not.toContain("app.quit()");
  });

  test("connect-bootstrap applies only the verified health body", () => {
    const start = mainSource.indexOf("// <connect-bootstrap-preflight>");
    const end = mainSource.indexOf("// </connect-bootstrap-preflight>");
    const slice = mainSource.slice(start, end);
    expect(slice).toContain("applyVerifiedLogtoHealthBody(");
    expect(slice).toContain("initialColdBootObservation.healthBody");
    expect(slice).not.toContain("fetch(");
    expect(slice).not.toContain("AbortSignal.timeout");
  });
});

describe("Bootstrap health classification (four bad-boot inputs)", () => {
  test("1 — server unreachable (fetch throws)", () => {
    expect(
      classifyBootstrap({
        hasServerUrl: true,
        fetchOk: false,
        fetchJson: null,
        fetchThrew: true,
        pairedServerIdentity: "x",
      }),
    ).toBe("disconnected");
  });

  test("2 — 200 but body is not Nautilo health", () => {
    expect(
      classifyBootstrap({
        hasServerUrl: true,
        fetchOk: true,
        fetchJson: { message: "Route GET:/ not found" },
        fetchThrew: false,
        pairedServerIdentity: null,
      }),
    ).toBe("disconnected");
  });

  test("3 — wrong-server identity mismatch", () => {
    expect(
      classifyBootstrap({
        hasServerUrl: true,
        fetchOk: true,
        fetchJson: {
          status: "ok",
          logtoDesktopAppId: "a",
          logtoResource: "r",
        },
        fetchThrew: false,
        pairedServerIdentity: "b|r",
      }),
    ).toBe("wrong-server");
  });

  test("4 — no persisted pairing (no server URL in context)", () => {
    expect(
      classifyBootstrap({
        hasServerUrl: false,
        fetchOk: false,
        fetchJson: null,
        fetchThrew: false,
        pairedServerIdentity: null,
      }),
    ).toBe("no-pairing");
  });
});
