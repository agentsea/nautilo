/** D103 — production feed authority and eligibility stay pure and fixed. */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  request,
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions,
  type Server,
} from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CancellationToken, HttpExecutor } from "builder-util-runtime";
import type { BlockMap } from "builder-util-runtime/out/blockMapApi";
import type { AppUpdater } from "electron-updater/out/AppUpdater";
import { GenericDifferentialDownloader } from "electron-updater/out/differentialDownloader/GenericDifferentialDownloader";
import { GenericProvider } from "electron-updater/out/providers/GenericProvider";
import type { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor";
import {
  UpdateController,
  type ElectronUpdaterFacade,
  type UpdaterEvent,
} from "../../electron/updater";
import { resolveProductionUpdaterEligibility } from "../../electron/updater-eligibility";

const builder = readFileSync(join(import.meta.dir, "../../electron-builder.yml"), "utf8");
const fixtureRoot = join(import.meta.dir, "../fixtures/updater");

/** Node adapter used only to let electron-updater's real GenericProvider talk to localhost. */
class LocalHttpExecutor extends HttpExecutor<ClientRequest> {
  createRequest(options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest {
    return request(options, callback);
  }
}

class ProviderBackedUpdater implements ElectronUpdaterFacade {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  readonly listeners = new Map<UpdaterEvent, Set<(...args: unknown[]) => void>>();
  private files: ReturnType<GenericProvider["resolveFiles"]> = [];
  private updateInfo: Awaited<ReturnType<GenericProvider["getLatestVersion"]>> | null = null;
  downloaded: Buffer | null = null;

  constructor(
    private readonly provider: GenericProvider,
    private readonly executor: LocalHttpExecutor,
    private readonly installedVersion = "0.8.0",
  ) {}

  on(event: UpdaterEvent, listener: (...args: unknown[]) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeListener(event: UpdaterEvent, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  async checkForUpdates(): Promise<void> {
    this.updateInfo = await this.provider.getLatestVersion();
    this.files = this.provider.resolveFiles(this.updateInfo);
    this.emit(
      compareStableVersions(this.updateInfo.version, this.installedVersion) > 0
        ? "update-available"
        : "update-not-available",
      this.updateInfo,
    );
  }

  async downloadUpdate(): Promise<void> {
    const zip = this.files.find((file) => file.url.pathname.endsWith(".zip"));
    if (!zip || !this.updateInfo) throw new Error("Generic provider did not resolve a ZIP update");
    this.downloaded = await this.executor.downloadToBuffer(zip.url, {
      cancellationToken: new CancellationToken(),
      sha512: zip.info.sha512,
    });
    this.emit("update-downloaded", this.updateInfo);
  }

  quitAndInstall(): void {
    throw new Error("The local provider integration test must never install");
  }

  private emit(event: UpdaterEvent, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

function compareStableVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function latestManifest(version: string, artifactName: string, artifact: Buffer): Buffer {
  const sha512 = createHash("sha512").update(artifact).digest("base64");
  return Buffer.from(
    [
      `version: ${version}`,
      "files:",
      `  - url: ${artifactName}`,
      `    sha512: ${sha512}`,
      `    size: ${artifact.length}`,
      `path: ${artifactName}`,
      `sha512: ${sha512}`,
      "releaseDate: '2026-09-03T00:00:00.000Z'",
      "",
    ].join("\n"),
  );
}

async function startFixtureServer(): Promise<{
  baseUrl: string;
  requests: string[];
  setFile: (pathname: string, body: Buffer) => void;
  close: () => Promise<void>;
}> {
  const files = new Map<string, Buffer>([
    ["/latest-mac.yml", readFileSync(join(fixtureRoot, "latest-mac.yml"))],
    ["/Nautilo-0.15.0-universal-mac.zip", readFileSync(join(fixtureRoot, "Nautilo-0.15.0-universal-mac.zip"))],
    ["/Nautilo-0.15.0-universal-mac.zip.blockmap", readFileSync(join(fixtureRoot, "Nautilo-0.15.0-universal-mac.zip.blockmap"))],
    ["/Nautilo-0.14.0-universal-mac.zip.blockmap", readFileSync(join(fixtureRoot, "Nautilo-0.14.0-universal-mac.zip.blockmap"))],
  ]);
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    requests.push(pathname);
    const body = files.get(pathname);
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-length": body.length });
    res.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local updater fixture server did not bind a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    requests,
    setFile: (pathname, body) => files.set(pathname, body),
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe("D103 production updater eligibility", () => {
  test("compiles one vendor-owned generic feed prefix", () => {
    expect(builder).toContain("provider: generic");
    expect(builder).toContain("url: https://media.nautilo.ai/desktop/stable/mac/");
    expect(builder).toContain("useMultipleRangeRequest: false");
    expect(builder).not.toMatch(/updates\.invalid|https?:\/\/[^\n]*(?:\$\{|process\.env)/);
  });

  test.each([
    [{ isPackaged: true, version: "0.14.0", isTest: false }, { enabled: true, disabledReason: null }],
    [{ isPackaged: false, version: "0.14.0", isTest: false }, { enabled: false, disabledReason: "unpackaged" }],
    [{ isPackaged: true, version: "0.0.0-dev", isTest: false }, { enabled: false, disabledReason: "development" }],
    [{ isPackaged: true, version: "0.14.0-rc.1", isTest: false }, { enabled: false, disabledReason: "development" }],
    [{ isPackaged: true, version: "0.14.0", isTest: true }, { enabled: false, disabledReason: "test" }],
    [{ isPackaged: true, version: "01.14.0", isTest: false }, { enabled: false, disabledReason: "development" }],
  ])("keeps non-production build %# inert", (input, expected) => {
    expect(resolveProductionUpdaterEligibility(input)).toEqual(expected);
  });

  test("selects N directly from N−7 and refreshes a mutable standard pointer before download", async () => {
    const fixture = await startFixtureServer();
    try {
      const executor = new LocalHttpExecutor();
      const provider = new GenericProvider(
        { provider: "generic", url: fixture.baseUrl, useMultipleRangeRequest: false },
        { channel: null, isAddNoCacheQuery: false } as AppUpdater,
        {
          platform: "darwin",
          isUseMultipleRangeRequest: false,
          executor: executor as unknown as ElectronHttpExecutor,
        },
      );
      const updater = new ProviderBackedUpdater(provider, executor);
      expect(provider.isUseMultipleRangeRequest).toBe(false);
      const controller = new UpdateController({
        updater,
        productionFeedEnabled: true,
        ui: {
          showAvailable: () => "later",
          showReady: () => "later",
          showNoUpdate: () => undefined,
          showError: () => undefined,
        },
      });

      await controller.checkNow();
      expect(controller.getState()).toEqual({ kind: "available", update: { version: "0.15.0" } });
      expect(updater.autoDownload).toBe(false);
      expect(updater.autoInstallOnAppQuit).toBe(false);
      expect(fixture.requests).toEqual(["/latest-mac.yml"]);

      const nextArtifactName = "Nautilo-0.16.0-universal-mac.zip";
      const nextArtifact = Buffer.from("Nautilo 0.16.0 mutable latest-pointer fixture");
      fixture.setFile(`/${nextArtifactName}`, nextArtifact);
      fixture.setFile("/latest-mac.yml", latestManifest("0.16.0", nextArtifactName, nextArtifact));

      await controller.downloadUpdate();
      expect(controller.getState()).toEqual({ kind: "available", update: { version: "0.16.0" } });
      expect(updater.downloaded).toBeNull();
      expect(fixture.requests).toEqual(["/latest-mac.yml", "/latest-mac.yml"]);

      await controller.downloadUpdate();
      expect(controller.getState()).toEqual({ kind: "ready", update: { version: "0.16.0" } });
      expect(updater.downloaded).toEqual(nextArtifact);

      const latest = await provider.getLatestVersion();
      const zip = provider.resolveFiles(latest).find((file) => file.url.pathname.endsWith(".zip"));
      expect(zip?.url.href).toBe(`${fixture.baseUrl}${nextArtifactName}`);
      if (!zip) throw new Error("Generic provider did not resolve the fixture ZIP");
      const blockmaps = await provider.getBlockMapFiles(zip.url, "0.15.0", "0.16.0");
      expect(blockmaps.map((url) => url.pathname)).toEqual([
        "/Nautilo-0.15.0-universal-mac.zip.blockmap",
        "/Nautilo-0.16.0-universal-mac.zip.blockmap",
      ]);
      expect(fixture.requests).toEqual([
        "/latest-mac.yml",
        "/latest-mac.yml",
        "/latest-mac.yml",
        `/${nextArtifactName}`,
        "/latest-mac.yml",
      ]);
      controller.dispose();
    } finally {
      await fixture.close();
    }
  });

  test("reconstructs through single ranges and keeps a checksum-valid full-download fallback", async () => {
    const sharedHead = Buffer.from("shared-head|");
    const sharedTail = Buffer.from("|shared-tail");
    const oldMiddle = Buffer.from("old-middle");
    const newMiddle = Buffer.from("new-middle");
    const oldArtifact = Buffer.concat([sharedHead, oldMiddle, sharedTail]);
    const newArtifact = Buffer.concat([sharedHead, newMiddle, sharedTail]);
    const checksum = (value: Buffer) => createHash("sha256").update(value).digest("base64");
    const blockMap = (middle: Buffer): BlockMap => ({
      version: "2",
      files: [
        {
          name: "file",
          offset: 0,
          checksums: [checksum(sharedHead), checksum(middle), checksum(sharedTail)],
          sizes: [sharedHead.length, middle.length, sharedTail.length],
        },
      ],
    });
    const requests: Array<{ range: string | null; bytes: number }> = [];
    const server = createServer((req, res) => {
      const range = typeof req.headers.range === "string" ? req.headers.range : null;
      if (!range) {
        requests.push({ range, bytes: newArtifact.length });
        res.writeHead(200, { "content-length": newArtifact.length, "content-type": "application/zip" });
        res.end(newArtifact);
        return;
      }
      if (range.includes(",")) {
        requests.push({ range, bytes: newArtifact.length });
        res.writeHead(200, { "content-length": newArtifact.length, "content-type": "application/zip" });
        res.end(newArtifact);
        return;
      }
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!match) {
        res.writeHead(416).end();
        return;
      }
      const start = Number(match[1]);
      const end = Number(match[2]);
      const body = newArtifact.subarray(start, end + 1);
      requests.push({ range, bytes: body.length });
      res.writeHead(206, {
        "content-length": body.length,
        "content-range": `bytes ${start}-${end}/${newArtifact.length}`,
        "content-type": "application/zip",
      });
      res.end(body);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Differential fixture server did not bind");
    const root = await mkdtemp(join(tmpdir(), "nautilo-updater-differential-"));
    try {
      const oldFile = join(root, "old.zip");
      const newFile = join(root, "new.zip");
      await writeFile(oldFile, oldArtifact);
      const progress: number[] = [];
      const executor = new LocalHttpExecutor();
      const newUrl = new URL(`http://127.0.0.1:${address.port}/target.zip`);
      await new GenericDifferentialDownloader(
        {
          size: newArtifact.length,
          sha512: createHash("sha512").update(newArtifact).digest("base64"),
        },
        executor,
        {
          oldFile,
          newFile,
          newUrl,
          logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
          requestHeaders: null,
          isUseMultipleRangeRequest: false,
          cancellationToken: new CancellationToken(),
          onProgress: (event) => progress.push(event.percent),
        },
      ).download(blockMap(oldMiddle), blockMap(newMiddle));

      expect(await readFile(newFile)).toEqual(newArtifact);
      expect(requests.every((entry) => entry.range !== null && !entry.range.includes(","))).toBe(true);
      expect(requests.reduce((total, entry) => total + entry.bytes, 0)).toBe(newMiddle.length);
      expect(requests.reduce((total, entry) => total + entry.bytes, 0)).toBeLessThan(newArtifact.length);
      expect(progress.at(-1)).toBe(100);

      requests.length = 0;
      const fallback = await executor.downloadToBuffer(newUrl, {
        cancellationToken: new CancellationToken(),
        sha512: createHash("sha512").update(newArtifact).digest("base64"),
      });
      expect(fallback).toEqual(newArtifact);
      expect(requests).toEqual([{ range: null, bytes: newArtifact.length }]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await closeServer(server);
    }
  });
});
