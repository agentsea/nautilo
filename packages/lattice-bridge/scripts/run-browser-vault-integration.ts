import { mkdtemp, rm } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromium,
  firefox,
  webkit,
  type BrowserType,
} from "playwright";

const expectedChecks = [
  "pending-bootstrap-restart-cas",
  "pending-bootstrap-nonextractable-fail-closed",
  "shared-conformance",
  "unlock",
  "round-trip",
  "non-extractable-key-persistence",
  "non-extractable",
  "namespace-cache-callback-outside-document-lock",
  "namespace-cache-restart-evict-nonextractable",
  "multi-instance-serialization",
  "journal-artifact-access-restart",
  "journal-round-trip-restart-cas-reentrant",
  "journal-non-extractable-no-plaintext",
  "journal-corruption",
  "journal-storage-loss",
  "journal-transition-isolation",
  "artifact-sidecar-restart",
  "no-fallback",
  "storage-loss",
] as const;

async function runEngine(
  name: string,
  browserType: BrowserType,
  url: string,
): Promise<void> {
  console.log(`[browser-vault] ${name}: launching`);
  const browser = await browserType.launch({ headless: true, timeout: 15_000 });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "load", timeout: 15_000 });
    console.log(`[browser-vault] ${name}: running harness`);
    const checks = await page.evaluate(() =>
      Promise.race([
        window.runNautiloBrowserVaultTest(),
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error("browser vault harness timed out")),
            15_000,
          );
        }),
      ]),
    );
    if (JSON.stringify(checks) !== JSON.stringify(
      expectedChecks,
    )) {
      throw new Error(`${name} returned incomplete browser vault evidence`);
    }
    console.log(`[browser-vault] ${name}: ${checks.join(", ")}`);
  } finally {
    await browser.close();
  }
}

const outputDirectory = await mkdtemp(
  join(tmpdir(), "nautilo-browser-vault-build-"),
);
const openMlsVendorDirectory = join(
  import.meta.dir,
  "../../lattice-crypto/vendor/openmls-wasm",
);

try {
  const result = await Bun.build({
    entrypoints: [
      join(
        import.meta.dir,
        "../tests/browser/client-profile-vault.browser.ts",
      ),
    ],
    outdir: outputDirectory,
    target: "browser",
    format: "esm",
    minify: false,
    sourcemap: "none",
  });
  if (!result.success || result.outputs.length !== 1) {
    throw new Error("browser vault harness failed to bundle");
  }
  const bundle = result.outputs[0]!;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/vault.js") {
        return new Response(Bun.file(bundle.path), {
          headers: { "content-type": "text/javascript; charset=utf-8" },
        });
      }
      if (path === "/vendor/openmls-wasm/openmls_wasm.js") {
        return new Response(Bun.file(join(
          openMlsVendorDirectory,
          "openmls_wasm.js",
        )), {
          headers: { "content-type": "text/javascript; charset=utf-8" },
        });
      }
      if (path === "/vendor/openmls-wasm/openmls_wasm_bg.wasm") {
        return new Response(Bun.file(join(
          openMlsVendorDirectory,
          "openmls_wasm_bg.wasm",
        )), {
          headers: { "content-type": "application/wasm" },
        });
      }
      return new Response(
        '<!doctype html><script type="module" src="/vault.js"></script>',
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });

  try {
    const url = `http://${server.hostname}:${server.port}/`;
    const engines: [string, BrowserType][] = [
      ["chromium", chromium],
      ["firefox", firefox],
    ];
    if (
      process.platform === "darwin"
      && Number.parseInt(release().split(".")[0]!, 10) < 24
    ) {
      console.warn(
        "[browser-vault] webkit: NOT RUN on macOS 14; "
          + "Playwright freezes this platform build. Linux CI remains required.",
      );
    } else {
      engines.push(["webkit", webkit]);
    }
    for (const [name, browserType] of engines) {
      await runEngine(name, browserType, url);
    }
  } finally {
    await server.stop(true);
  }
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}
