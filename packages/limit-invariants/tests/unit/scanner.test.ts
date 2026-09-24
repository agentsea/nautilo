import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LIMIT_DETECTOR_COVERAGE, scanRepository, scanRepositoryWithEvidence } from "../../src/node/scanner";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "limit-invariants-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  return root;
}

describe("deterministic limit scanner", () => {
  test("excludes ignored visual-eval run reports but scans authored cases and extractor code", async () => {
    const root = await fixture({
      "dev/evals/browser-visual-grounding/.results/run.json": JSON.stringify({ maxChoices: 255 }),
      "dev/evals/browser-visual-grounding/cases/example/case.json": JSON.stringify({ maxChoices: 12 }),
      "dev/evals/browser-visual-grounding/classic-grounding.ts": "export const MAX_REGION_CANDIDATES = 80;",
    });
    const observations = await scanRepository(root, { sourceRoots: ["dev"] });
    expect(observations.map((item) => item.path)).toEqual([
      "dev/evals/browser-visual-grounding/cases/example/case.json",
      "dev/evals/browser-visual-grounding/classic-grounding.ts",
    ]);
  });

  test("does not mistake captured timings and oracle coordinates for policy ceilings", async () => {
    const root = await fixture({
      "dev/evals/browser-visual-grounding/cases/example/case.json": JSON.stringify({
        captureDurationMs: 45,
        maxChoices: 12,
      }),
      "dev/evals/browser-visual-grounding/visual-oracles.json": JSON.stringify({
        cases: [{ expectedTarget: { region: { xMin: 1, xMax: 120, yMin: 2, yMax: 130 } } }],
        maxChoices: 6,
      }),
    });
    const observations = await scanRepository(root, { sourceRoots: ["dev"] });
    expect(observations.map((item) => item.detector)).toEqual(["json:maxChoices", "json:maxChoices"]);
  });

  test("excludes only the mini-app build cache while scanning authored app siblings", async () => {
    const root = await fixture({
      "packages/first-party-apps/.cache/video/hash/main.js": "const payloadLimit = 42;",
      "packages/first-party-apps/video/src/main.ts": "export const payloadLimit = 42;",
      "packages/example/.cache/source.ts": "export const otherLimit = 84;",
    });
    const scan = await scanRepositoryWithEvidence(root, { sourceRoots: ["packages"] });
    expect(scan.observations.map(item => item.path)).toEqual([
      "packages/example/.cache/source.ts",
      "packages/first-party-apps/video/src/main.ts",
    ]);
    expect([...scan.linksByLocator.values()].flat().some(link => link.path.startsWith("packages/first-party-apps/.cache/"))).toBe(false);
  });
  test("finds named aliases and behavior sinks without inventing authority", async () => {
    const root = await fixture({
      "packages/example/src/sample.ts": [
        "const responseCeiling = 16 * 1024;",
        "export function crop(value: string) {",
        "  return value.slice(0, responseCeiling);",
        "}",
        "setTimeout(() => undefined, 30_000);",
      ].join("\n"),
    });
    const observations = await scanRepository(root, { sourceRoots: ["packages"] });
    expect(observations.flatMap((item) => item.effects)).toContain("bound");
    expect(observations.map((item) => item.effect)).toContain("truncate");
    expect(observations.map((item) => item.effect)).toContain("terminate");
    const responsePacket = observations.find((item) => item.locator.includes("responseCeiling"));
    expect(responsePacket?.value).toBe("16384");
    expect(responsePacket?.siteCount).toBe(2);
    expect(responsePacket?.effects).toEqual(["truncate", "bound"]);
    expect(observations.filter((item) => item.locator === responsePacket?.locator)).toHaveLength(1);
    expect(JSON.stringify(observations)).not.toContain("classification");
    expect(JSON.stringify(observations)).not.toContain("authority");
    expect(await scanRepository(root, { sourceRoots: ["packages"] })).toEqual(observations);
  });

  test("covers structured configuration with format-specific extraction confidence", async () => {
    const root = await fixture({
      ".github/workflows/ci.yml": "jobs:\n  lint:\n    timeout-minutes: 12\n",
      "packages/example/config.json": JSON.stringify({ maxPayloadBytes: 4096 }),
      "scripts/run.sh": "timeout 30s ./worker\n",
    });
    const observations = await scanRepository(root, { sourceRoots: [".github", "packages", "scripts"] });
    expect(observations.map((item) => [item.sourceKind, item.effect])).toEqual([
      ["yaml", "terminate"],
      ["json", "payload"],
      ["shell", "terminate"],
    ]);
    expect(observations.map((item) => item.reachability)).toEqual(["operator_ci", "live", "operator_ci"]);
  });

  test("does not promote ordinary names and structural operations into fake limits", async () => {
    const root = await fixture({
      "apps/example/src/noise.ts": [
        "const payloadHash = 'abc';",
        "const payloadVersion = 2;",
        "const fontSize = 14;",
        "const copy = ['a', 'b'].slice();",
        "const pair = ['a', 'b', 'c'].slice(0, 2);",
        "const larger = Math.max(1, 2);",
        "transitionConnectionAttempt(3);",
      ].join("\n"),
    });
    expect(await scanRepository(root, { sourceRoots: ["apps"] })).toEqual([]);
  });

  test("excludes generated first-party app engines while scanning authored siblings and owned sources", async () => {
    const root = await fixture({
      "packages/first-party-apps/spreadsheet/engine/generated.ts":
        "export const GENERATED_RESPONSE_LIMIT = 999;\n",
      "packages/first-party-apps/presentation/engine/generated.ts":
        "export const GENERATED_PRESENTATION_LIMIT = 998;\n",
      "packages/first-party-apps/spreadsheet/src/authored.ts":
        "export const AUTHORED_RESPONSE_LIMIT = 321;\n",
      "packages/first-party-apps/presentation/src/authored.ts":
        "export const AUTHORED_PRESENTATION_LIMIT = 320;\n",
      "packages/office-slides/src/owned.ts":
        "export const OWNED_SLIDES_LIMIT = 319;\n",
    });
    const observations = await scanRepository(root, { sourceRoots: ["packages"] });
    expect(observations.map((item) => [item.path, item.value])).toEqual([
      ["packages/first-party-apps/presentation/src/authored.ts", "320"],
      ["packages/first-party-apps/spreadsheet/src/authored.ts", "321"],
      ["packages/office-slides/src/owned.ts", "319"],
    ]);
  });

  test("finds behavior even when the numeric alias has an innocuous name", async () => {
    const root = await fixture({
      "packages/example/src/evasion.ts": [
        "const n = 1024;",
        "export function validate(value: string) {",
        "  if (Buffer.byteLength(value, 'utf8') > n) throw new Error('large');",
        "  return boundedUtf8(value, n);",
        "}",
        "query.limit(25);",
        "z.string().max(200);",
      ].join("\n"),
      "packages/example/tests/fixture.test.ts": "setTimeout(() => undefined, 250);\n",
      "packages/example/vendor/library.ts": "const timeoutMs = 250;\n",
      "packages/example/generated/output.ts": "const responseLimit = 250;\n",
    });
    const observations = await scanRepository(root, { sourceRoots: ["packages"] });
    expect(observations.map((item) => [item.effect, item.value])).toContainEqual(["reject", "1024"]);
    expect(observations.map((item) => [item.effect, item.value])).toContainEqual(["truncate", "1024"]);
    expect(observations.map((item) => item.effect)).toContain("paginate");
    expect(observations.map((item) => item.effect)).toContain("schema_max");
    expect(observations.find((item) => item.path.includes("tests/"))?.reachability).toBe("test");
    expect(observations.find((item) => item.path.includes("vendor/"))?.reachability).toBe("vendor");
    expect(observations.find((item) => item.path === "packages/example/generated/output.ts")?.reachability).toBe("generated");
  });

  test("covers retry, retention, chunking, concurrency, and unresolved semantic sinks", async () => {
    const root = await fixture({
      "packages/example/src/families.ts": [
        "const maxRetries = 3;",
        "const retentionDays = 30;",
        "const batchItems = 128;",
        "const concurrencyLimit = 4;",
        "retryWithBackoff(run, maxRetries);",
        "chunkArray(rows, batchItems);",
        "pLimit(concurrencyLimit);",
        "const partial = value.slice(0, externalMaximum);",
      ].join("\n"),
    });
    const observations = await scanRepository(root, { sourceRoots: ["packages"] });
    const effects = new Set(observations.flatMap((item) => item.effects));
    expect(effects).toEqual(new Set(["retry", "evict", "chunk", "concurrency", "truncate"]));
    expect(observations.find((item) => item.effects.includes("truncate"))?.value)
      .toBe("unresolved:externalMaximum");
  });

  test("fails live malformed JSON with its exact path but ignores malformed evidence fixtures", async () => {
    const liveRoot = await fixture({ "packages/example/config.json": "{ invalid" });
    let liveError = "";
    try {
      await scanRepository(liveRoot, { sourceRoots: ["packages"] });
    } catch (error) {
      liveError = error instanceof Error ? error.message : String(error);
    }
    expect(liveError).toContain("Cannot inventory malformed JSON packages/example/config.json");

    const evidenceRoot = await fixture({ "packages/example/tests/fixtures/config.json": "{ invalid" });
    expect(await scanRepository(evidenceRoot, { sourceRoots: ["packages"] })).toEqual([]);
  });

  test("exposes direct returned boundaries and correct character-length comparison evidence", async () => {
    const root = await fixture({
      "packages/sandbox/src/spawn.ts": [
        "export function defaultInlineBytes() {",
        "  return 16 * 1024;",
        "}",
        "export function* maximumFrameBytes() {",
        "  yield 4 * 1024;",
        "}",
      ].join("\n"),
      "packages/agent/src/tools/shell/run-shell.ts": [
        "const MIN_TIMEOUT_REASON_LENGTH = 12;",
        "export function valid(reason: string) {",
        "  return reason.length >= MIN_TIMEOUT_REASON_LENGTH;",
        "}",
      ].join("\n"),
    });
    const scan = await scanRepositoryWithEvidence(root, { sourceRoots: ["packages"], lanes: ["primary"] });
    const observations = scan.observations;
    const returned = observations.find((item) => item.path.endsWith("spawn.ts"));
    expect(returned?.reasonCodes).toContain("returned_boundary_expression");
    expect(returned?.value).toBe("16384");
    expect(returned?.unit).toBe("bytes");
    expect(observations.find((item) => item.detector === "yield:maximumFrameBytes")?.reasonCodes)
      .toContain("yielded_boundary_expression");
    const reason = observations.find((item) => item.detector === "named:MIN_TIMEOUT_REASON_LENGTH");
    expect(reason?.siteCount).toBe(1);
    expect(reason?.unit).toBe("characters");
    expect(reason?.effects).toEqual(["bound"]);
    expect(reason?.effects).not.toContain("terminate");
    expect(scan.linksByLocator.get(reason!.locator)?.some((link) => link.reasonCode === "measured_boundary_comparison")).toBe(true);
  });

  test("returns deterministic navigation evidence without pretending it is authority", async () => {
    const root = await fixture({
      "packages/example/src/limits.ts": "export const MAX_CONTENT_CHARS = 96;\n",
      "packages/example/src/read.ts": [
        "import { MAX_CONTENT_CHARS } from './limits';",
        "export function readContent(value: string, nextCursor?: string) {",
        "  return value.slice(0, MAX_CONTENT_CHARS);",
        "}",
      ].join("\n"),
      "packages/example/src/generated.ts": [
        "const MAX_BLOCKS = 96;",
        "export const source = String.raw`const CONTENT_CAP = ${MAX_BLOCKS};`;",
      ].join("\n"),
      "packages/other/src/policy.ts": "const MAX_CONTENT_CHARS = 96;\nexport const cropped = value.slice(0, MAX_CONTENT_CHARS);\n",
    });
    const scan = await scanRepositoryWithEvidence(root, { sourceRoots: ["packages"] });
    expect(scan.coverage).toEqual(LIMIT_DETECTOR_COVERAGE);
    const imported = scan.observations.find((item) => item.detector === "named:MAX_CONTENT_CHARS" && item.path.endsWith("limits.ts"));
    expect(scan.linksByLocator.get(imported!.locator)?.map((link) => link.kind)).toContain("import");
    const generated = scan.observations.find((item) => item.detector === "named:MAX_BLOCKS");
    expect(scan.linksByLocator.get(generated!.locator)?.map((link) => link.kind)).toContain("generated_consumer");
    const familyLinks = [...scan.linksByLocator.values()].flat().filter((link) => link.kind === "policy_family");
    expect(familyLinks.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(familyLinks)).not.toContain("classification");
    expect(await scanRepositoryWithEvidence(root, { sourceRoots: ["packages"] })).toEqual(scan);
  });
});
