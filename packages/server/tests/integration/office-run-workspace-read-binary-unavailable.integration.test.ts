import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NautiloApiClient } from "@nautilo/api-client";
import {
  __resetSharedDirectAgentDbForTests,
  artifactNamespaces,
  artifacts,
  eq,
  fileRevisions,
  rooms,
} from "@nautilo/db";
import { resolveInstance } from "@nautilo/config";
import type { NamespaceMemoryEnvelope } from "@nautilo/trust";
import { createAppToolHost } from "../../src/apps/app-tool-host";
import type { MiniAppManifest } from "../../src/apps/app-manifest";
import type { AppToolRunnerContext } from "../../src/apps/app-tool-types";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

let fixture: AppFixture;
let artifactId = "";
let artifactStorageUri = "";
let artifactPath = "";
let unavailableVendorRoot = "";
let namespaceId = "";
let previousAgentConnection: string | undefined;

beforeAll(async () => {
  unavailableVendorRoot = await mkdtemp(
    join(tmpdir(), "office-run-unavailable-"),
  );
  fixture = await setupOwnerAppFixture({
    suiteName: `offrun${crypto.randomUUID().replace(/-/g, "").slice(0, 6)}`,
    withDefaultAgentGraph: true,
  });

  previousAgentConnection = process.env["DB_AGENT_CONNECTION_STRING"];
  process.env["DB_AGENT_CONNECTION_STRING"] =
    resolveInstance().db.directConnection;
  await __resetSharedDirectAgentDbForTests();

  const [room] = await fixture.db
    .select({ namespaceId: rooms.namespaceId })
    .from(rooms)
    .where(eq(rooms.id, fixture.defaultRoomId!));
  if (!room?.namespaceId || !fixture.defaultAgentId) {
    throw new Error("fixture did not create an authorized workspace context");
  }
  namespaceId = room.namespaceId;

  const baseUrl = (await fixture.app.listen({
    port: 0,
    host: "127.0.0.1",
  })).replace(/\/$/, "");
  const client = new NautiloApiClient(baseUrl);
  client.setToken(await fixture.mintOwnerBearer());

  artifactPath = `office-run-${crypto.randomUUID()}.docx`;
  const created = await client.createWorkspaceArtifact(
    new Blob(["workspace-source-is-readable"], { type: DOCX_MIME }),
    {
      path: artifactPath,
      mimeType: DOCX_MIME,
      roomId: fixture.defaultRoomId!,
    },
  );
  artifactId = created.id;

  const [persisted] = await fixture.db
    .select({ storageUri: artifacts.storageUri })
    .from(artifacts)
    .where(eq(artifacts.id, artifactId));
  if (!persisted) throw new Error("created workspace artifact was not persisted");
  artifactStorageUri = persisted.storageUri!;
});

afterAll(async () => {
  try {
    if (artifactId) {
      const absolutePath = new URL(artifactStorageUri).pathname;
      await fixture.db
        .delete(fileRevisions)
        .where(eq(fileRevisions.absolutePath, absolutePath));
      await fixture.db
        .delete(artifactNamespaces)
        .where(eq(artifactNamespaces.artifactId, artifactId));
      await fixture.db.delete(artifacts).where(eq(artifacts.id, artifactId));
      await rm(new URL(artifactStorageUri), { force: true });
    }
  } finally {
    await fixture?.cleanup();
    await __resetSharedDirectAgentDbForTests();
    if (previousAgentConnection === undefined) {
      delete process.env["DB_AGENT_CONNECTION_STRING"];
    } else {
      process.env["DB_AGENT_CONNECTION_STRING"] = previousAgentConnection;
    }
    if (unavailableVendorRoot) {
      await rm(unavailableVendorRoot, { recursive: true, force: true });
    }
  }
});

describe("office.run workspace read with unavailable OfficeCLI", () => {
  test("returns UNAVAILABLE after successfully reading a valid workspace source", async () => {
    if (!namespaceId || !fixture.defaultAgentId) {
      throw new Error("fixture did not create an authorized workspace context");
    }

    const envelope: NamespaceMemoryEnvelope = {
      ownerId: fixture.ownerId,
      actorId: fixture.ownerActorId,
      agentId: fixture.defaultAgentId,
      roomId: fixture.defaultRoomId!,
      readableNamespaces: [namespaceId],
      mutableNamespaces: [namespaceId],
      writableNamespaces: [namespaceId],
      toolPolicy: {},
    };
    const context: AppToolRunnerContext = {
      ownerId: fixture.ownerId,
      userId: fixture.ownerId,
      agentId: fixture.defaultAgentId,
      roomId: fixture.defaultRoomId!,
      memoryAccessEnvelope: envelope,
    };
    const manifest: MiniAppManifest = {
      id: "office-run-unavailable-test",
      name: "Office Run Unavailable Test",
      version: "1.0.0",
      entry: "./main.ts",
      html: "./index.html",
      fileAssociations: { extensions: [], mimeTypes: [] },
      capabilities: {
        document: { artifact: "read", currentFolder: "none" },
        office: "convert",
      },
    };

    const previousOfficeCliPath = process.env["OFFICECLI_PATH"];
    const previousOfficeCliVendorRoot = process.env["OFFICECLI_VENDOR_ROOT"];
    const previousPath = process.env["PATH"];
    process.env["OFFICECLI_PATH"] = join(
      unavailableVendorRoot,
      "missing-officecli",
    );
    process.env["OFFICECLI_VENDOR_ROOT"] = unavailableVendorRoot;
    process.env["PATH"] = "";
    try {
      const host = createAppToolHost({
        appId: manifest.id,
        appsRoot: "/tmp/does-not-matter",
        manifest,
        context,
      });
      const result = await host.office.run({
        input: { surface: "workspace", path: artifactPath },
        readArgv: ["get", "/body", "--json"],
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("UNAVAILABLE");
    } finally {
      if (previousOfficeCliPath === undefined) {
        delete process.env["OFFICECLI_PATH"];
      } else {
        process.env["OFFICECLI_PATH"] = previousOfficeCliPath;
      }
      if (previousOfficeCliVendorRoot === undefined) {
        delete process.env["OFFICECLI_VENDOR_ROOT"];
      } else {
        process.env["OFFICECLI_VENDOR_ROOT"] = previousOfficeCliVendorRoot;
      }
      if (previousPath === undefined) {
        delete process.env["PATH"];
      } else {
        process.env["PATH"] = previousPath;
      }
    }
  });
});
