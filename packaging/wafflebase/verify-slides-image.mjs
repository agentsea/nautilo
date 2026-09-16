import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as bunBuild } from "bun";

const here = dirname(fileURLToPath(import.meta.url));
const checkoutRoot = resolve(here, "../..");
const checkoutInputs = {
  writer: "/checkout/writer",
  slidesIcon: "/checkout/slides.svg",
  slidesPreview: "/checkout/slides-preview.png",
};
const containerScript = "/verify-slides-image.mjs";
const sourceRevisionPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const expectedPreviewAlt =
  "Nautilo Slides showing a Studio North launch presentation with slide thumbnails and speaker notes";

function fail(message) {
  throw new Error(message);
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertFile(path, label = path) {
  if (!existsSync(path) || !statSync(path).isFile())
    fail(`Missing ${label}: ${path}`);
}

function filesBelow(root, path = "", excludedDirectories = new Set()) {
  const files = [];
  for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
    const child = path ? `${path}/${entry.name}` : entry.name;
    if (entry.isDirectory() && !excludedDirectories.has(entry.name)) {
      files.push(...filesBelow(root, child, excludedDirectories));
    } else if (entry.isFile()) files.push(child);
  }
  return files.sort();
}

function packageFiles(root) {
  return filesBelow(root, "", new Set(["node_modules"]));
}

function isTestFile(path) {
  return (
    /(?:^|\/)tests?\//.test(path) ||
    /\.(?:integration\.)?test\.[cm]?[jt]sx?$/.test(path)
  );
}

function assertSafeManifestPath(path) {
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path)) {
    fail(`Invalid engine manifest path: ${String(path)}`);
  }
  const normalized = normalize(path).replaceAll("\\", "/");
  if (normalized !== path || path === ".." || path.startsWith("../")) {
    fail(`Engine manifest path escapes its package: ${path}`);
  }
}

async function docker(args, options = {}) {
  const child = spawn("docker", args, {
    cwd: checkoutRoot,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", chunk => { stdout += chunk; });
  child.stderr?.on("data", chunk => { stderr += chunk; });
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve(code ?? signal));
  });
  if (status !== 0) fail(`docker ${args[0]} failed (${status})${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
  return { stdout };
}

async function inspectImage(image, expectedSourceRevision) {
  const result = await docker(["image", "inspect", image]);
  let records;
  try {
    records = JSON.parse(result.stdout);
  } catch {
    fail("Docker returned invalid JSON while inspecting the image");
  }
  if (!Array.isArray(records) || records.length !== 1)
    fail(`Expected exactly one local image for ${image}`);
  const record = records[0];
  const revision =
    record?.Config?.Labels?.["org.opencontainers.image.revision"];
  if (revision !== expectedSourceRevision) {
    fail(
      `Image source revision mismatch: expected ${expectedSourceRevision}, received ${String(revision)}`,
    );
  }
  if (
    typeof record.Id !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(record.Id)
  ) {
    fail(`Docker returned an invalid immutable image ID for ${image}`);
  }
  return { imageId: record.Id, sourceRevision: revision };
}

async function verifyInsideContainer(expectedSourceRevision, imageId) {
  const appRoot = "/srv/repo/packages/first-party-apps";
  const slidesRoot = join(appRoot, "presentation");
  const engineRoot = join(slidesRoot, "engine");
  const workbenchRoot = "/srv/workbench";

  for (const name of ["presentation", "spreadsheet", "writer"]) {
    if (!existsSync(join(appRoot, name)))
      fail(`Required packaged app is absent: ${name}`);
  }
  for (const name of ["notes", "board"]) {
    if (existsSync(join(appRoot, name)))
      fail(`Unexpected packaged app is present: ${name}`);
  }

  const provenancePath = join(engineRoot, "provenance.json");
  assertFile(provenancePath, "Slides engine provenance");
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
  if (!sha256Pattern.test(provenance.sourceSha256 ?? ""))
    fail("Invalid Slides engine source SHA-256");
  if (!sourceRevisionPattern.test(provenance.revision ?? ""))
    fail("Invalid Slides upstream revision");
  if (
    !provenance.files ||
    typeof provenance.files !== "object" ||
    Array.isArray(provenance.files)
  ) {
    fail("Slides engine provenance has no file manifest");
  }

  const engineEntries = Object.entries(provenance.files);
  if (engineEntries.length === 0)
    fail("Slides engine provenance file manifest is empty");
  for (const [path, expectedHash] of engineEntries) {
    assertSafeManifestPath(path);
    if (!sha256Pattern.test(expectedHash))
      fail(`Invalid engine hash in provenance: ${path}`);
    const packagedPath = join(engineRoot, path);
    assertFile(packagedPath, "manifested Slides engine file");
    const actualHash = digest(packagedPath);
    if (actualHash !== expectedHash) fail(`Engine hash mismatch: ${path}`);
  }
  const engineManifestFiles = new Set(engineEntries.map(([path]) => path));
  const unmanifestedEngineFiles = filesBelow(engineRoot).filter(
    (path) => path !== "provenance.json" && !engineManifestFiles.has(path),
  );
  if (unmanifestedEngineFiles.length > 0) {
    fail(
      `Slides engine contains unmanifested files: ${unmanifestedEngineFiles.join(", ")}`,
    );
  }

  const engine = await import(join(engineRoot, "node.js"));
  await import(join(engineRoot, "browser.js"));
  for (const name of ["importPptx", "exportPptx", "MemSlidesStore"]) {
    if (typeof engine[name] !== "function")
      fail(`Missing Slides engine export: ${name}`);
  }

  const build = await bunBuild({
    entrypoints: [join(slidesRoot, "main.ts")],
    target: "browser",
    write: false,
  });
  if (!build.success)
    fail(
      `Slides browser bundle failed:\n${build.logs.map((log) => log.message).join("\n")}`,
    );

  const packagedWriterRoot = join(appRoot, "writer");
  const checkoutWriterRoot = checkoutInputs.writer;
  const packagedWriterFiles = packageFiles(packagedWriterRoot);
  const checkoutWriterFiles = packageFiles(checkoutWriterRoot);
  if (packagedWriterFiles.length === 0) fail("Packaged Writer source is empty");

  const writerMismatches = [];
  for (const path of packagedWriterFiles) {
    const checkoutPath = join(checkoutWriterRoot, path);
    if (!existsSync(checkoutPath))
      writerMismatches.push(`${path}: missing from checkout`);
    else if (digest(join(packagedWriterRoot, path)) !== digest(checkoutPath))
      writerMismatches.push(`${path}: hash mismatch`);
  }
  const packagedWriterSet = new Set(packagedWriterFiles);
  const writerHostOnlyFiles = checkoutWriterFiles.filter(
    (path) => !packagedWriterSet.has(path),
  );
  const writerHostOnlyNonTestFiles = writerHostOnlyFiles.filter(
    (path) => !isTestFile(path),
  );
  if (writerMismatches.length > 0 || writerHostOnlyNonTestFiles.length > 0) {
    fail(
      `Writer source parity failed: ${JSON.stringify({ writerMismatches, writerHostOnlyNonTestFiles })}`,
    );
  }

  const artwork = [
    ["slides.svg", "slidesSvgSha256", checkoutInputs.slidesIcon],
    ["slides-preview.png", "slidesPreviewSha256", checkoutInputs.slidesPreview],
  ];
  const artworkResult = {};
  for (const [filename, key, checkoutPath] of artwork) {
    const packagedPath = join(workbenchRoot, "apps/office", filename);
    assertFile(packagedPath, `packaged Slides artwork ${filename}`);
    assertFile(checkoutPath, `checkout Slides artwork ${filename}`);
    const packagedHash = digest(packagedPath);
    const checkoutHash = digest(checkoutPath);
    if (packagedHash !== checkoutHash)
      fail(`Slides artwork differs from checkout: ${filename}`);
    artworkResult[key] = packagedHash;
  }

  const registryNeedles = [
    "/apps/office/slides.svg",
    "/apps/office/slides-preview.png",
    expectedPreviewAlt,
  ];
  const registryBundles = filesBelow(join(workbenchRoot, "assets"))
    .filter((path) => path.endsWith(".js"))
    .filter((path) => {
      const contents = readFileSync(
        join(workbenchRoot, "assets", path),
        "utf8",
      );
      return registryNeedles.every((needle) => contents.includes(needle));
    });
  if (registryBundles.length === 0)
    fail("Workbench bundle does not contain the exact Slides artwork registry");

  console.log(
    JSON.stringify(
      {
        imageId,
        sourceRevision: expectedSourceRevision,
        engine: {
          files: engineEntries.length,
          allHashesVerified: true,
          sourceSha256: provenance.sourceSha256,
          upstreamRevision: provenance.revision,
          nodeImport: true,
          browserImport: true,
          browserBundle: true,
        },
        packageBoundary: {
          presentation: "present",
          spreadsheet: "present",
          writer: "present",
          notes: "absent",
          board: "absent",
        },
        writer: {
          sourceParity: true,
          packagedFiles: packagedWriterFiles.length,
          checkoutOnlyTestFiles: writerHostOnlyFiles.length,
        },
        artwork: {
          ...artworkResult,
          matchesCheckout: true,
          registryBundles,
          registryContainsIconPreviewAndExactAlt: true,
        },
        container: {
          network: "none",
          rootFilesystem: "read-only",
          checkoutMount: "read-only",
          databaseMounts: 0,
        },
      },
      null,
      2,
    ),
  );
}

async function verifyFromHost(image, expectedSourceRevision) {
  if (!image || !expectedSourceRevision || process.argv.length !== 4) {
    fail(
      "Usage: bun packaging/wafflebase/verify-slides-image.mjs IMAGE FULL_SOURCE_SHA",
    );
  }
  if (!sourceRevisionPattern.test(expectedSourceRevision)) {
    fail(
      "FULL_SOURCE_SHA must be a lowercase, unabbreviated 40- or 64-character hexadecimal revision",
    );
  }
  assertFile(
    join(checkoutRoot, "package.json"),
    "repository root package.json",
  );
  assertFile(fileURLToPath(import.meta.url), "Slides image verifier");
  const writerSource = join(checkoutRoot, "packages/first-party-apps/writer");
  const slidesIconSource = join(
    checkoutRoot,
    "apps/workbench/public/apps/office/slides.svg",
  );
  const slidesPreviewSource = join(
    checkoutRoot,
    "apps/workbench/public/apps/office/slides-preview.png",
  );
  assertFile(join(writerSource, "app.json"), "checkout Writer source");
  assertFile(slidesIconSource, "checkout Slides icon");
  assertFile(slidesPreviewSource, "checkout Slides preview");

  const inspected = await inspectImage(image, expectedSourceRevision);
  await docker(
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev",
      "--mount",
      `type=bind,source=${fileURLToPath(import.meta.url)},target=${containerScript},readonly`,
      "--mount",
      `type=bind,source=${writerSource},target=${checkoutInputs.writer},readonly`,
      "--mount",
      `type=bind,source=${slidesIconSource},target=${checkoutInputs.slidesIcon},readonly`,
      "--mount",
      `type=bind,source=${slidesPreviewSource},target=${checkoutInputs.slidesPreview},readonly`,
      "--entrypoint",
      "/usr/local/bin/bun",
      inspected.imageId,
      containerScript,
      "--inside",
      expectedSourceRevision,
      inspected.imageId,
    ],
    { stdio: "inherit" },
  );
}

try {
  const args = process.argv.slice(2);
  if (args[0] === "--inside") {
    if (
      args.length !== 3 ||
      !sourceRevisionPattern.test(args[1]) ||
      !/^sha256:[0-9a-f]{64}$/.test(args[2])
    ) {
      fail("Invalid internal Slides image verification invocation");
    }
    await verifyInsideContainer(args[1], args[2]);
  } else {
    await verifyFromHost(args[0], args[1]);
  }
} catch (error) {
  console.error(
    `Slides image verification failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
