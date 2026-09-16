/**
 * D448 Phase 6.1 — Office compatibility-only lane.
 *
 * The guarded owner fixture supplies the real test-cruft DB, artifact-store,
 * trust envelope, and production app host. The only substitute is a tiny
 * OfficeCLI executable: it supplies a deterministic importer envelope and
 * OOXML-looking output bytes, while the server still owns staging, output
 * validation, artifact rows, namespace attachment, and runtime events.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetSharedDirectAgentDbForTests,
  artifactNamespaces,
  artifacts,
  attachArtifactToNamespace,
  eq,
  fileRevisions,
  inArray,
  insertArtifact,
  rooms,
} from "@nautilo/db";
import { resetOfficeCliVerificationCache } from "@nautilo/config/officecli";
import { resolveInstance } from "@nautilo/config";
import { eventBus } from "@nautilo/runtime";
import type { ServerEvent } from "@nautilo/types";
import type { NamespaceMemoryEnvelope } from "@nautilo/trust";
import { parseWriterHtml } from "../../../first-party-apps/writer/src/office-document";
import { importDocx } from "../../../first-party-apps/writer/src/agent-tool-handlers";
import { createAppToolHost } from "../../src/apps/app-tool-host";
import type { MiniAppManifest } from "../../src/apps/app-manifest";
import type { AppToolRunnerContext } from "../../src/apps/app-tool-types";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const createdArtifactIds: string[] = [];
let fx: AppFixture;
let namespaceId = "";
let artifactRoot = "";
let fakeOfficeRoot = "";
let officeLogPath = "";
let sourcePath = "";
let sourceArtifactId = "";
let sourceBytes: Buffer;
let previousAgentConnection: string | undefined;
const previousEnv: Record<string, string | undefined> = {};

function rememberEnv(name: string): void {
  previousEnv[name] = process.env[name];
}

function restoreEnv(name: string): void {
  const value = previousEnv[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function officeManifest(): MiniAppManifest {
  return {
    id: "d448-office-compatibility",
    name: "D448 Office Compatibility",
    version: "1.0.0",
    entry: "./main.ts",
    html: "./index.html",
    fileAssociations: { extensions: [], mimeTypes: [] },
    capabilities: {
      document: { artifact: "readwrite", currentFolder: "none" },
      office: "convert",
    },
  };
}

function writerHostContext(): AppToolRunnerContext {
  if (!fx.defaultAgentId || !fx.defaultRoomId) throw new Error("fixture did not create an agent graph");
  const envelope: NamespaceMemoryEnvelope = {
    ownerId: fx.ownerId,
    actorId: fx.ownerActorId,
    agentId: fx.defaultAgentId,
    roomId: fx.defaultRoomId,
    readableNamespaces: [namespaceId],
    mutableNamespaces: [namespaceId],
    writableNamespaces: [namespaceId],
    toolPolicy: {},
  };
  return {
    ownerId: fx.ownerId,
    userId: fx.ownerId,
    agentId: fx.defaultAgentId,
    roomId: fx.defaultRoomId,
    memoryAccessEnvelope: envelope,
  };
}

beforeAll(async () => {
  fx = await setupOwnerAppFixture({
    suiteName: `d448of${Date.now().toString(36)}`,
    withDefaultAgentGraph: true,
  });
  const [room] = await fx.db
    .select({ namespaceId: rooms.namespaceId })
    .from(rooms)
    .where(eq(rooms.id, fx.defaultRoomId!));
  if (!room?.namespaceId) throw new Error("fixture default room has no namespace");
  namespaceId = room.namespaceId;

  // The production app host reaches the agent-scoped DB adapter. Point that
  // adapter at the fixture's guarded test-cruft direct connection only.
  previousAgentConnection = process.env["DB_AGENT_CONNECTION_STRING"];
  process.env["DB_AGENT_CONNECTION_STRING"] = resolveInstance().db.directConnection;
  await __resetSharedDirectAgentDbForTests();

  artifactRoot = await mkdtemp(join(tmpdir(), "d448-office-artifacts-"));
  fakeOfficeRoot = await mkdtemp(join(tmpdir(), "d448-fake-officecli-"));
  officeLogPath = join(fakeOfficeRoot, "commands.log");
  const fakeOfficeCli = join(fakeOfficeRoot, "officecli");
  await writeFile(fakeOfficeCli, String.raw`#!/bin/sh
printf '%s\n' "$1" >> "$D448_OFFICE_LOG"
case "$1" in
  get)
    printf '%s\n' '{"success":true,"data":{"path":"/body","type":"body","children":[{"path":"/body/p[1]","type":"paragraph","children":[{"path":"/body/p[1]/r[1]","type":"run","text":"D448 imported paragraph"}]}]}}'
    ;;
  create)
    printf '\120\113\003\004d448-office-output' > "$2"
    printf '%s\n' '{"success":true}'
    ;;
  batch)
    printf '%s\n' '{"summary":{"failed":0}}'
    ;;
  close)
    printf '%s\n' '{"success":true}'
    ;;
  *)
    printf '%s\n' 'unsupported fake officecli command' >&2
    exit 64
    ;;
esac
`, "utf8");
  await chmod(fakeOfficeCli, 0o755);
  for (const name of ["OFFICECLI_PATH", "OFFICECLI_SKIP_UPDATE", "D448_OFFICE_LOG"]) {
    rememberEnv(name);
  }
  process.env["OFFICECLI_PATH"] = fakeOfficeCli;
  process.env["OFFICECLI_SKIP_UPDATE"] = "1";
  process.env["D448_OFFICE_LOG"] = officeLogPath;
  resetOfficeCliVerificationCache();

  sourcePath = `d448/office-source-${crypto.randomUUID()}.docx`;
  sourceBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x64, 0x34, 0x34, 0x38]);
  const sourceAbsPath = join(artifactRoot, "source.docx");
  await writeFile(sourceAbsPath, sourceBytes);
  const source = await insertArtifact(
    {
      artifactId: `d448-office-source-${crypto.randomUUID()}`,
      path: sourcePath,
      storageUri: `file://${sourceAbsPath}`,
      mimeType: DOCX_MIME,
      size: sourceBytes.byteLength,
    },
    fx.db as unknown as NonNullable<Parameters<typeof insertArtifact>[1]>,
  );
  sourceArtifactId = source.id;
  createdArtifactIds.push(source.id);
  await attachArtifactToNamespace(
    { artifactId: source.id, namespaceId },
    fx.db as unknown as NonNullable<Parameters<typeof attachArtifactToNamespace>[1]>,
  );
});

afterAll(async () => {
  try {
    if (createdArtifactIds.length > 0) {
      const rows = await fx.db
        .select({ id: artifacts.id, storageUri: artifacts.storageUri })
        .from(artifacts)
        .where(inArray(artifacts.id, createdArtifactIds));
      const paths = rows.map((row) => new URL(row.storageUri!).pathname);
      if (paths.length > 0) {
        await fx.db.delete(fileRevisions).where(inArray(fileRevisions.absolutePath, paths));
      }
      await fx.db.delete(artifactNamespaces).where(inArray(artifactNamespaces.artifactId, createdArtifactIds));
      await fx.db.delete(artifacts).where(inArray(artifacts.id, createdArtifactIds));
      await Promise.all(paths.map((path) => rm(path, { force: true })));
    }
  } finally {
    await fx?.cleanup();
    await __resetSharedDirectAgentDbForTests();
    if (previousAgentConnection === undefined) delete process.env["DB_AGENT_CONNECTION_STRING"];
    else process.env["DB_AGENT_CONNECTION_STRING"] = previousAgentConnection;
    for (const name of Object.keys(previousEnv)) restoreEnv(name);
    resetOfficeCliVerificationCache();
    if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
    if (fakeOfficeRoot) await rm(fakeOfficeRoot, { recursive: true, force: true });
  }
});

describe("D448 Workspace office.run importer compatibility", () => {
  test("imports through the real workspace artifact commit path and writes isolated compatibility output without a coordinator patch fallback", async () => {
    const host = createAppToolHost({
      appId: "nautilo-writer",
      appsRoot: "../../first-party-apps",
      manifest: officeManifest(),
      context: writerHostContext(),
    });
    const importedPath = `d448/imported-${crypto.randomUUID()}.html`;
    const outputPath = `d448/exported-${crypto.randomUUID()}.docx`;
    const changedEvents: ServerEvent[] = [];
    const patchEvents: ServerEvent[] = [];
    const handler = (event: ServerEvent) => {
      if (event.type === "workspace.artifact.changed" && (event.path === importedPath || event.path === outputPath)) {
        changedEvents.push(event);
      }
      if (event.type === "document.patch.applied") patchEvents.push(event);
    };
    eventBus.on(handler);

    try {
      const imported = await importDocx({
        source: { surface: "workspace", path: sourcePath },
        targetPath: importedPath,
      }, { nautiloApp: host });
      expect(imported).toMatchObject({
        ok: true,
        status: "imported",
        artifactPath: importedPath,
        blockCount: 1,
      });

      const [importedRow] = await fx.db
        .select({ id: artifacts.id, revision: artifacts.revision, mimeType: artifacts.mimeType, storageUri: artifacts.storageUri })
        .from(artifacts)
        .where(eq(artifacts.path, importedPath));
      if (!importedRow) throw new Error("Writer importer did not create its workspace artifact");
      createdArtifactIds.push(importedRow.id);
      expect(importedRow).toMatchObject({ revision: 1, mimeType: "text/html" });
      const importedHtml = await readFile(new URL(importedRow.storageUri!), "utf8");
      const parsedImported = parseWriterHtml(importedHtml);
      expect(parsedImported).toMatchObject({ ok: true });
      if (parsedImported.ok) {
        expect((parsedImported.document.document.blocks[0] as { inlines: Array<{ text: string }> }).inlines[0]?.text)
          .toBe("D448 imported paragraph");
      }
      const [importedAttachment] = await fx.db
        .select({ namespaceId: artifactNamespaces.namespaceId })
        .from(artifactNamespaces)
        .where(eq(artifactNamespaces.artifactId, importedRow.id));
      // Import colocation is part of the real document.createDocument commit;
      // it must keep the new Writer HTML in the source's writable namespace.
      expect(importedAttachment?.namespaceId).toBe(namespaceId);

      const output = await host.office.run({
        ops: [{ command: "add", parent: "/body", type: "paragraph", props: { text: "compatibility" } }],
        output: { surface: "workspace", path: outputPath },
      });
      expect(output).toMatchObject({
        ok: true,
        displayPath: outputPath,
        byteLength: Buffer.byteLength(Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Buffer.from("d448-office-output")])),
      });

      const [outputRow] = await fx.db
        .select({ id: artifacts.id, revision: artifacts.revision, mimeType: artifacts.mimeType, storageUri: artifacts.storageUri })
        .from(artifacts)
        .where(eq(artifacts.path, outputPath));
      if (!outputRow) throw new Error("office.run did not create its output artifact");
      createdArtifactIds.push(outputRow.id);
      expect(outputRow).toMatchObject({ revision: 1, mimeType: DOCX_MIME });
      const outputBytes = await readFile(new URL(outputRow.storageUri!));
      expect(outputBytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

      const [sourceAfter] = await fx.db
        .select({ revision: artifacts.revision, storageUri: artifacts.storageUri })
        .from(artifacts)
        .where(eq(artifacts.id, sourceArtifactId));
      expect(sourceAfter?.revision).toBe(1);
      expect(Array.from(await readFile(new URL(sourceAfter!.storageUri!)))).toEqual(Array.from(sourceBytes));
      expect(changedEvents).toHaveLength(2);
      expect(patchEvents).toHaveLength(0);
      expect((await readFile(officeLogPath, "utf8")).trim().split("\n")).toEqual([
        "get",
        "create",
        "batch",
        "close",
      ]);
    } finally {
      eventBus.off(handler);
    }
  });
});
