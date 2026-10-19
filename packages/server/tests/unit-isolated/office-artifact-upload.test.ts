import { afterEach, expect, mock, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { zipSync } from "fflate";
import * as actualDb from "@nautilo/db";

const insert = mock(async (input: Record<string, unknown>) => ({ ...input, id: "artifact-row", revision: 1, createdAt: new Date(0), updatedAt: new Date(0) }));
const attach = mock(async (_input: { artifactId: string; namespaceId: string }) => {});
const namespacesForArtifacts = mock(async (ids: string[]) => new Map(ids.map(id => [id, ["namespace-a"]])));
mock.module("@nautilo/db", () => ({ ...actualDb, insertArtifact: insert, attachArtifactToNamespace: attach, getArtifactNamespaces: async () => ["namespace-a"], getNamespacesForArtifactIds: namespacesForArtifacts }));
const { workspaceArtifactsRoutes } = await import("../../src/routes/workspace-artifacts");
const roots: string[] = [];
afterEach(async () => { insert.mockClear(); attach.mockClear(); namespacesForArtifacts.mockClear(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test("late Office markers reach artifact persistence; renamed or malformed archives are removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "office-route-"));
  roots.push(root);
  const previous = process.env["NAUTILO_ARTIFACTS_ROOT"];
  process.env["NAUTILO_ARTIFACTS_ROOT"] = root;
  const app = Fastify();
  app.decorateRequest("memoryEnvelope", null);
  app.addHook("preHandler", (request, _reply, done) => {
    request.memoryEnvelope = { memoryMode: "namespace", ownerId: "owner-a", actorId: "actor-a", agentId: "agent-a", roomId: "room-a",
      readableNamespaces: [], mutableNamespaces: [], writableNamespaces: ["namespace-a"], toolPolicy: {} } as never;
    done();
  });
  await app.register(multipart);
  workspaceArtifactsRoutes(app, { assertCanWriteArtifacts: async () => {} });
  try {
    const xml = new TextEncoder().encode("<synthetic/>");
    const office = zipSync({ "xl/worksheets/sheet1.xml": new Uint8Array(256 * 1024).fill(0x61), "xl/workbook.xml": xml, "_rels/.rels": xml, "[Content_Types].xml": xml }, { level: 0 });
    for (const [name, bytes, expected] of [["sample.xlsx", office, 200], ["renamed.docx", office, 415], ["fake.xlsx", zipSync({ "notes.txt": xml }), 415], ["broken.xlsx", office.subarray(0, office.length - 1), 415]] as const) {
      const form = new FormData();
      form.set("path", name); form.set("file", new Blob([new Uint8Array(bytes).buffer]), name);
      const response = await app.inject({ method: "POST", url: "/api/workspace/artifacts?roomId=room-a", payload: form });
      expect(response.statusCode).toBe(expected);
      if (expected === 200) expect(response.json()).toMatchObject({ path: name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", namespaceIds: ["namespace-a"] });
      else expect(response.json()).toMatchObject({ code: "invalid_office_package" });
      expect(await readdir(root)).toHaveLength(1);
    }
    expect(insert).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(namespacesForArtifacts).toHaveBeenCalledTimes(1);
    expect(namespacesForArtifacts.mock.calls[0]).toEqual([["artifact-row"]]);
    expect(attach.mock.calls[0]).toEqual([{ artifactId: "artifact-row", namespaceId: "namespace-a" }]);
  } finally {
    await app.close();
    if (previous === undefined) delete process.env["NAUTILO_ARTIFACTS_ROOT"];
    else process.env["NAUTILO_ARTIFACTS_ROOT"] = previous;
  }
});
