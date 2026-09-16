#!/usr/bin/env bun
/**
 * Task 0.1 browser-only byte probe.
 *
 * It starts the real Workbench Vite server, imports only Silurus's direct
 * format subpaths in Chromium, and calls the three parser factories with
 * independent copies of the existing smoke fixtures. It intentionally does
 * not mount Canvas viewers: visual rendering, production output, server,
 * Docker, and Electron closure remain later Phase 0 gates.
 *
 * Run: bun --cwd apps/workbench run scripts/ooxml-contract-probe.ts
 */
import { chromium } from "playwright";
import { resolve } from "node:path";

const WORKBENCH_ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(WORKBENCH_ROOT, "../..");
const VITE_PORT = 4178;
const VITE_URL = `http://127.0.0.1:${VITE_PORT}`;
const SYSTEM_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const smokeFixtures = {
  docx: resolve(REPO_ROOT, "apps/desktop/scratch/d362-spike/sample/sample.docx"),
  xlsx: resolve(REPO_ROOT, "apps/desktop/scratch/d362-spike/sample/sample.xlsx"),
  pptx: resolve(REPO_ROOT, "apps/desktop/scratch/d362-spike/sample/sample.pptx"),
} as const;

type Format = keyof typeof smokeFixtures;
type ParsedResult = Record<Format, { byteLength: number; count: number; inputDetached: boolean }>;
type RejectedLimitResult = Record<Format, {
  code: string;
  workersConstructed: number;
  workersTerminated: number;
}>;
type ProbeResult = {
  parsed: ParsedResult;
  rejectedLimit: RejectedLimitResult;
};

async function waitForVite(): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(VITE_URL);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await Bun.sleep(250);
  }
  throw new Error(`Vite did not become reachable at ${VITE_URL}`);
}

async function main(): Promise<void> {
  if (!(await Bun.file(SYSTEM_CHROME).exists())) {
    throw new Error(
      `System Chrome is unavailable at ${SYSTEM_CHROME}; install/provide Chromium before running this local probe.`,
    );
  }

  const [docx, xlsx, pptx] = await Promise.all(
    Object.values(smokeFixtures).map(async (fixture) => new Uint8Array(await Bun.file(fixture).arrayBuffer())),
  );
  const vite = Bun.spawn({
    cmd: [
      "bun",
      "--bun",
      "vite",
      "--force",
      "--host",
      "127.0.0.1",
      "--port",
      String(VITE_PORT),
      "--strictPort",
    ],
    cwd: WORKBENCH_ROOT,
    stdout: "ignore",
    stderr: "pipe",
  });

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await waitForVite();
    browser = await chromium.launch({ headless: true, executablePath: SYSTEM_CHROME });
    const page = await browser.newPage();
    // This is a Vite-transformed module, not the authenticated SPA entrypoint:
    // it remains same-origin without app boot redirects while retaining Vite's
    // dependency resolution for the direct Silurus subpath imports.
    await page.goto(`${VITE_URL}/src/viewers/ooxml/contract.ts`, { waitUntil: "load" });
    const result = await page.evaluate(
      async ({ docxBytes, xlsxBytes, pptxBytes }) => {
        // This served Vite module contains the three direct package subpath
        // imports. Do not dynamically import bare specifiers from page.evaluate:
        // those bypass Vite's dependency resolver.
        const contractPath = "/src/viewers/ooxml/contract.ts";
        const contract = await import(contractPath);
        const { docx: DocxDocument, xlsx: XlsxWorkbook, pptx: PptxPresentation } =
          contract.OOXML_PARSER_CONTRACT;
        const clone = (bytes: number[]): ArrayBuffer => new Uint8Array(bytes).slice().buffer;
        const options = contract.OOXML_SAFE_LOAD_OPTIONS;
        let docx: Awaited<ReturnType<typeof DocxDocument.load>> | undefined;
        let xlsx: Awaited<ReturnType<typeof XlsxWorkbook.load>> | undefined;
        let pptx: Awaited<ReturnType<typeof PptxPresentation.load>> | undefined;
        try {
          // Formats have different transfer behavior (DOCX/PPTX detach; XLSX
          // currently clones/retains), so every factory receives independent
          // ownership and the observation is recorded below.
          const docxInput = clone(docxBytes);
          const xlsxInput = clone(xlsxBytes);
          const pptxInput = clone(pptxBytes);
          docx = await DocxDocument.load(docxInput, options);
          xlsx = await XlsxWorkbook.load(xlsxInput, options);
          pptx = await PptxPresentation.load(pptxInput, options);
          const parsed = {
            docx: {
              byteLength: docxBytes.length,
              count: docx.pageCount,
              inputDetached: docxInput.byteLength === 0,
            },
            xlsx: {
              byteLength: xlsxBytes.length,
              count: xlsx.sheetNames.length,
              inputDetached: xlsxInput.byteLength === 0,
            },
            pptx: {
              byteLength: pptxBytes.length,
              count: pptx.slideCount,
              inputDetached: pptxInput.byteLength === 0,
            },
          };

          const NativeWorker = window.Worker;
          const counts = { constructed: 0, terminated: 0 };
          class ObservedWorker extends NativeWorker {
            constructor(...args: ConstructorParameters<typeof Worker>) {
              super(...args);
              counts.constructed += 1;
            }
            terminate(): void {
              counts.terminated += 1;
              super.terminate();
            }
          }
          window.Worker = ObservedWorker;
          const rejectAtOneByte = async (
            factory: { load(bytes: ArrayBuffer, loadOptions: typeof options): Promise<unknown> },
            bytes: number[],
          ) => {
            counts.constructed = 0;
            counts.terminated = 0;
            let code = "";
            try {
              await factory.load(clone(bytes), {
                ...options,
                resourceLimits: {
                  maxArchiveEntryBytes: 1,
                  maxTotalInflatedBytes: 1,
                },
              });
            } catch (error) {
              code = typeof error === "object" && error !== null && "code" in error
                ? String((error as { code: unknown }).code)
                : "";
            }
            await new Promise((done) => window.setTimeout(done, 25));
            return {
              code,
              workersConstructed: counts.constructed,
              workersTerminated: counts.terminated,
            };
          };
          try {
            return {
              parsed,
              rejectedLimit: {
                docx: await rejectAtOneByte(DocxDocument, docxBytes),
                xlsx: await rejectAtOneByte(XlsxWorkbook, xlsxBytes),
                pptx: await rejectAtOneByte(PptxPresentation, pptxBytes),
              },
            };
          } finally {
            window.Worker = NativeWorker;
          }
        } finally {
          docx?.destroy();
          xlsx?.destroy();
          pptx?.destroy();
        }
      },
      {
        docxBytes: Array.from(docx),
        xlsxBytes: Array.from(xlsx),
        pptxBytes: Array.from(pptx),
      },
    );
    const typedResult = result as ProbeResult;
    for (const format of Object.keys(smokeFixtures) as Format[]) {
      if (typedResult.parsed[format].byteLength === 0 || typedResult.parsed[format].count === 0) {
        throw new Error(`${format} probe did not produce parsed document metadata`);
      }
      const rejected = typedResult.rejectedLimit[format];
      if (
        rejected.code !== "ooxml-resource-limit" ||
        rejected.workersConstructed !== 1 ||
        rejected.workersTerminated !== 1
      ) {
        throw new Error(`${format} did not reject and clean up its resource-limited worker`);
      }
    }
    process.stdout.write(`${JSON.stringify({ runtime: "system-chrome", result: typedResult }, null, 2)}\n`);
  } finally {
    await browser?.close();
    vite.kill();
    await vite.exited;
  }
}

await main();
