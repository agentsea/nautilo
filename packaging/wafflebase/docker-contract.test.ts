import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../..");
async function sources(): Promise<{ dockerfile: string; ignore: string }> {
  const [dockerfile, ignore] = await Promise.all([
    readFile(resolve(repositoryRoot, "packaging/docker/Dockerfile"), "utf8"),
    readFile(resolve(repositoryRoot, ".dockerignore"), "utf8"),
  ]);
  return { dockerfile, ignore };
}

function stage(dockerfile: string, name: string, nextStage: string): string {
  const marker = dockerfile.indexOf(` AS ${name}\n`);
  if (marker < 0) throw new Error(`missing ${name} Docker stage`);
  const start = dockerfile.lastIndexOf("\nFROM ", marker) + 1;
  const end = dockerfile.indexOf(nextStage, start);
  if (end < 0) throw new Error(`missing ${name} Docker stage boundary`);
  return dockerfile.slice(start, end);
}

describe("Wafflebase Sheets server-image contract", () => {
  test("source deployments build Sheets by default while retaining an explicit opt-out", async () => {
    const [source, runtime] = await Promise.all([
      readFile(resolve(repositoryRoot, "deploy/compose-driver/templates/docker-compose.source.yml"), "utf8"),
      readFile(resolve(repositoryRoot, "deploy/compose-driver/templates/docker-compose.yml"), "utf8"),
    ]);
    expect(source).toContain("NAUTILO_WAFFLEBASE_SHEETS: ${NAUTILO_WAFFLEBASE_SHEETS:-1}");
    expect(runtime).not.toContain("NAUTILO_WAFFLEBASE_SHEETS");
  });

  test("uses the existing Bun dependency stage and validates the build selection", async () => {
    const { dockerfile } = await sources();
    const buildStage = stage(dockerfile, "wafflebase-sheets-build", "# ─── Stage 4: runtime");

    expect(buildStage).toContain("FROM deps AS wafflebase-sheets-build");
    expect(buildStage).toContain("ARG NAUTILO_WAFFLEBASE_SHEETS=1");
    expect(buildStage).toContain('case "$NAUTILO_WAFFLEBASE_SHEETS" in');
    expect(buildStage).toContain("0) mkdir -p /out");
    expect(buildStage).toContain('NAUTILO_WAFFLEBASE_SHEETS must be 0 or 1');
  });

  test("builds Sheets from owned packages and produces a compiled artifact closure", async () => {
    const { dockerfile } = await sources();
    const buildStage = stage(dockerfile, "wafflebase-sheets-build", "# ─── Stage 4: runtime");

    expect(buildStage).toContain("COPY packages/office-core packages/office-core");
    expect(buildStage).toContain("COPY packages/office-sheets packages/office-sheets");
    expect(buildStage).toContain("bun packaging/wafflebase/artifacts.mjs /out/spreadsheet/engine");
    expect(buildStage).toContain("cp -a packages/first-party-apps/spreadsheet/. /out/spreadsheet/");
    expect(buildStage).not.toContain("third_party/wafflebase");
  });

  test("copies only maintained apps into runtime and excludes retired Spreadsheet Lite", async () => {
    const { dockerfile } = await sources();
    const runtime = stage(dockerfile, "runtime", "ARG NAUTILO_SOURCE_SHA");

    expect(runtime).toContain("COPY packages/first-party-apps/writer ./repo/packages/first-party-apps/writer");
    expect(runtime).toContain("COPY packages/first-party-apps/design ./repo/packages/first-party-apps/design");
    expect(runtime).toContain("COPY --from=wafflebase-sheets-build /out/ ./repo/packages/first-party-apps/");
    expect(runtime).toContain("COPY --from=deps /repo/packages/first-party-apps/writer/node_modules");
    expect(runtime).not.toContain("spreadsheet-lite");
    expect(runtime).not.toContain("fortune-sheet");
    expect(runtime).not.toMatch(/^COPY\s+packages\/first-party-apps\s/m);
    expect(runtime).not.toMatch(/^COPY\s+packages\/first-party-apps\/spreadsheet\s/m);
  });

  test("excludes generated engines from the Docker context", async () => {
    const { ignore } = await sources();

    expect(ignore).toContain("packages/first-party-apps/spreadsheet/engine/");
    expect(ignore).toContain("packages/first-party-apps/spreadsheet/engine.staging-*/");
    expect(ignore).toContain("packages/first-party-apps/spreadsheet/engine.previous-*/");
  });
});

describe("Slides server-image contract", () => {
  test("source deployments build Slides by default while retaining an explicit opt-out", async () => {
    const source = await readFile(resolve(repositoryRoot, "deploy/compose-driver/templates/docker-compose.source.yml"), "utf8");
    const runtime = await readFile(resolve(repositoryRoot, "deploy/compose-driver/templates/docker-compose.yml"), "utf8");
    expect(source).toContain("NAUTILO_WAFFLEBASE_SLIDES: ${NAUTILO_WAFFLEBASE_SLIDES:-1}");
    expect(runtime).not.toContain("NAUTILO_WAFFLEBASE_SLIDES");
  });

  test("builds the complete owned dependency closure while rejecting invalid selections", async () => {
    const { dockerfile } = await sources();
    const slides = stage(dockerfile, "wafflebase-slides-build", "# ─── Nautilo Office Board artifact");
    expect(slides).toContain("ARG NAUTILO_WAFFLEBASE_SLIDES=1");
    expect(slides).toContain('case "$NAUTILO_WAFFLEBASE_SLIDES" in');
    expect(slides).toContain("0) mkdir -p /out");
    expect(slides).toContain("NAUTILO_WAFFLEBASE_SLIDES must be 0 or 1");
    for (const name of ["core", "docs", "slides"]) {
      expect(slides).toContain(`COPY packages/office-${name} packages/office-${name}`);
    }
    expect(slides).toContain("bun packaging/wafflebase/slides-artifacts.mjs /out/presentation/engine");
    expect(slides).not.toMatch(/COPY packages\/first-party-apps\/(writer|spreadsheet|notes|board)\b/);
  });

  test("runtime consumes prepared Slides only and includes the host contract even when omitted", async () => {
    const { dockerfile, ignore } = await sources();
    const runtime = stage(dockerfile, "runtime", "ARG NAUTILO_SOURCE_SHA");
    expect(runtime).toContain("COPY --from=wafflebase-slides-build /out/ ./repo/packages/first-party-apps/");
    expect(runtime).toContain("COPY packages/first-party-apps/presentation/src/live-tool-contract.ts");
    expect(runtime).not.toMatch(/^COPY\s+packages\/first-party-apps\/presentation\s/m);
    expect(ignore).toContain("packages/first-party-apps/presentation/engine/");
    expect(ignore).toContain("packages/first-party-apps/presentation/engine.staging-*/");
    expect(ignore).toContain("packages/first-party-apps/presentation/engine.previous-*/");
  });
});

describe("Board server-image contract", () => {
  test("builds Board unconditionally from the complete owned dependency closure", async () => {
    const { dockerfile } = await sources();
    const board = stage(dockerfile, "wafflebase-board-build", "# ─── Stage 4: runtime");

    expect(board).not.toContain("ARG NAUTILO_WAFFLEBASE_BOARD");
    for (const name of ["core", "docs", "slides", "board"]) {
      expect(board).toContain(`COPY packages/office-${name} packages/office-${name}`);
    }
    expect(board).toContain("COPY packages/first-party-apps/board packages/first-party-apps/board");
    expect(board).toContain("packaging/wafflebase/upstream.json");
    expect(board).toContain("rm -rf /out/board/engine");
    expect(board).toContain("bun packaging/wafflebase/board-artifacts.ts /out/board/engine");
  });

  test("runtime consumes only the freshly prepared Board app", async () => {
    const { dockerfile } = await sources();
    const runtime = stage(dockerfile, "runtime", "ARG NAUTILO_SOURCE_SHA");

    expect(runtime).toContain("COPY --from=wafflebase-board-build /out/ ./repo/packages/first-party-apps/");
    expect(runtime).not.toMatch(/^COPY\s+packages\/first-party-apps\/board\b/m);
  });
});
