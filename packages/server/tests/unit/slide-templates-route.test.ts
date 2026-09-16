import { writeSlideTemplateBytes } from "../../src/lib/slide-template-service";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Artifact } from "@nautilo/db";
import { ArtifactWriteDeniedError } from "@nautilo/trust";
import {
  persistSlideTemplateArtifact,
  slideTemplateRoutes,
  SLIDE_TEMPLATE_MIME_TYPE,
  SLIDE_TEMPLATE_PATH_PREFIX,
  type SlideTemplateRouteService,
} from "../../src/routes/slide-templates";

const USER_A = "user-a";
const USER_B = "user-b";
const NS_A = "10000000-0000-4000-8000-000000000001";
const NS_B = "10000000-0000-4000-8000-000000000002";
const TEMPLATE_ID = "20000000-0000-4000-8000-000000000001";
const INTERNAL_ID = "30000000-0000-4000-8000-000000000001";
const MANIFEST = {
  documentType: "presentation",
  editor: "wafflebase",
  payloadId: "wafflebase-presentation",
  payloadFormat: "application/vnd.wafflebase.presentation+json",
  version: "1.0",
};
const PAYLOAD = {
  meta: { title: "Template", themeId: "theme-1", masterId: "master-1" },
  themes: [{ id: "theme-1" }],
  masters: [{ id: "master-1" }],
  layouts: [{ id: "layout-1" }],
  slides: [{ id: "slide-1", layoutId: "layout-1", elements: [], notes: [] }],
  guides: [],
};

function slideHtml(payload: unknown = PAYLOAD): string {
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><title>Presentation</title></head><body>',
    `<script id="manifest" type="application/vnd.nautilo.document+json">${JSON.stringify(MANIFEST).replace(/</g, "\\u003c")}</script>`,
    `<script id="wafflebase-presentation" type="application/vnd.wafflebase.presentation+json">${JSON.stringify(payload).replace(/</g, "\\u003c")}</script>`,
    "</body></html>",
  ].join("\n");
}

const CONTENT = slideHtml();
const apps: FastifyInstance[] = [];
const tempRoots: string[] = [];

function artifact(
  id: string = TEMPLATE_ID,
  name = "Launch",
  updatedAt = new Date("2026-09-11T10:00:00.000Z"),
): Artifact {
  const encoded = Buffer.from(name, "utf8").toString("base64url");
  return {
    id: id === TEMPLATE_ID ? INTERNAL_ID : id,
    artifactId: id,
    path: `${SLIDE_TEMPLATE_PATH_PREFIX}${id}.${encoded}.slide-template.html`,
    mimeType: SLIDE_TEMPLATE_MIME_TYPE,
    size: Buffer.byteLength(CONTENT),
    storageUri: `file:///artifacts/${id}`,
    revision: 1,
    createdAt: updatedAt,
    updatedAt,
    deletedAt: null,
  };
}

function service(overrides: Partial<SlideTemplateRouteService> = {}): Partial<SlideTemplateRouteService> {
  return {
    resolvePrivateNamespace: async (userId, actorId) => {
      if (actorId !== `${userId}-actor`) return null;
      return userId === USER_A ? NS_A : userId === USER_B ? NS_B : null;
    },
    listPage: async () => [],
    findById: async (id, namespaceId) =>
      id === TEMPLATE_ID && namespaceId === NS_A ? artifact() : null,
    getNamespaceIds: async () => [NS_A],
    read: async () => CONTENT,
    persist: async (input) => artifact(input.templateId, input.name),
    remove: async () => artifact(),
    assertCanWriteArtifacts: async () => undefined,
    publish: () => undefined,
    ...overrides,
  };
}

async function buildApp(overrides: Partial<SlideTemplateRouteService> = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest("sessionUserId", null);
  app.decorateRequest("sessionActorId", null);
  app.addHook("preHandler", async (request) => {
    const user = request.headers["x-test-user"];
    request.sessionUserId = typeof user === "string" ? user : null;
    request.sessionActorId = typeof user === "string" ? `${user}-actor` : null;
  });
  slideTemplateRoutes(app, service(overrides));
  await app.ready();
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Slides template routes", () => {
  test("requires a signed-in Human and keeps template ids private to that Human", async () => {
    const app = await buildApp();
    const unauthenticated = await app.inject({
      method: "GET",
      url: "/api/apps/nautilo-presentation/slide-templates",
    });
    expect(unauthenticated.statusCode).toBe(401);

    const foreign = await app.inject({
      method: "GET",
      url: `/api/apps/nautilo-presentation/slide-templates/${TEMPLATE_ID}`,
      headers: { "x-test-user": USER_B },
    });
    expect(foreign.statusCode).toBe(404);
  });

  test("paginates without a collection ceiling and rejects a cursor in another Human scope", async () => {
    const rows = Array.from({ length: 501 }, (_, index) => {
      const id = `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      return artifact(id, `Template ${index + 1}`, new Date(1_800_000_000_000 - index));
    });
    rows[0] = { ...rows[0]!, path: `${SLIDE_TEMPLATE_PATH_PREFIX}malformed` };
    let pageNumber = 0;
    const listPage = mock(async (_input: Parameters<SlideTemplateRouteService["listPage"]>[0]) =>
      pageNumber++ === 0 ? rows : []);
    const app = await buildApp({ listPage });
    const first = await app.inject({
      method: "GET",
      url: "/api/apps/nautilo-presentation/slide-templates",
      headers: { "x-test-user": USER_A },
    });
    expect(first.statusCode).toBe(200);
    const body: { templates: unknown[]; nextCursor: string | null } = first.json();
    expect(body.templates).toHaveLength(499);
    expect(typeof body.nextCursor).toBe("string");

    const second = await app.inject({
      method: "GET",
      url: `/api/apps/nautilo-presentation/slide-templates?cursor=${encodeURIComponent(body.nextCursor!)}`,
      headers: { "x-test-user": USER_A },
    });
    expect(second.statusCode).toBe(200);
    expect(listPage.mock.calls[1]?.[0].cursor?.id).toBe(rows[499]!.id);

    const before = listPage.mock.calls.length;
    const foreign = await app.inject({
      method: "GET",
      url: `/api/apps/nautilo-presentation/slide-templates?cursor=${encodeURIComponent(body.nextCursor!)}`,
      headers: { "x-test-user": USER_B },
    });
    expect(foreign.statusCode).toBe(400);
    expect(listPage.mock.calls).toHaveLength(before);
  });

  test("saves a copied template only after current Artifact RBAC admission", async () => {
    const persist = mock(async (input: Parameters<SlideTemplateRouteService["persist"]>[0]) =>
      artifact(input.templateId, input.name));
    const publish = mock((_event: Parameters<SlideTemplateRouteService["publish"]>[0]) => undefined);
    const app = await buildApp({ persist, publish });
    const response = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-presentation/slide-templates",
      headers: { "x-test-user": USER_A },
      payload: { name: "  Launch slide  ", content: CONTENT },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ name: "Launch slide" });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0]![0]).toMatchObject({
      name: "Launch slide",
      content: CONTENT,
      namespaceId: NS_A,
    });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  test("rejects empty, malformed and RBAC-denied saves before persistence", async () => {
    const persist = mock(async () => artifact());
    const app = await buildApp({ persist });
    for (const payload of [
      { name: "", content: CONTENT },
      { name: "Broken", content: "" },
      { name: "Broken", content: "not-json" },
      { name: "Broken", content: slideHtml([]) },
      { name: "Broken", content: slideHtml({ ...PAYLOAD, slides: [] }) },
      { name: "Broken", content: CONTENT, namespaceId: NS_B },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/apps/nautilo-presentation/slide-templates",
        headers: { "x-test-user": USER_A },
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(persist).not.toHaveBeenCalled();

    const denied = await buildApp({
      persist,
      assertCanWriteArtifacts: async (input) => { throw new ArtifactWriteDeniedError(input); },
    });
    const response = await denied.inject({
      method: "POST",
      url: "/api/apps/nautilo-presentation/slide-templates",
      headers: { "x-test-user": USER_A },
      payload: { name: "Denied", content: CONTENT },
    });
    expect(response.statusCode).toBe(403);
    expect(persist).not.toHaveBeenCalled();
  });

  test("rejects corrupt stored content and artifacts with any additional Namespace edge", async () => {
    const corrupt = await buildApp({ read: async () => "not-json" });
    const corruptResponse = await corrupt.inject({
      method: "GET",
      url: `/api/apps/nautilo-presentation/slide-templates/${TEMPLATE_ID}`,
      headers: { "x-test-user": USER_A },
    });
    expect(corruptResponse.statusCode).toBe(422);

    const remove = mock(async () => artifact());
    const shared = await buildApp({ getNamespaceIds: async () => [NS_A, NS_B], remove });
    const sharedResponse = await shared.inject({
      method: "DELETE",
      url: `/api/apps/nautilo-presentation/slide-templates/${TEMPLATE_ID}`,
      headers: { "x-test-user": USER_A },
    });
    expect(sharedResponse.statusCode).toBe(404);
    expect(remove).not.toHaveBeenCalled();
  });

  test("removes through the Artifact soft-delete lifecycle", async () => {
    const remove = mock(async () => artifact());
    const publish = mock((_event: Parameters<SlideTemplateRouteService["publish"]>[0]) => undefined);
    const app = await buildApp({ remove, publish });
    const response = await app.inject({
      method: "DELETE",
      url: `/api/apps/nautilo-presentation/slide-templates/${TEMPLATE_ID}`,
      headers: { "x-test-user": USER_A },
    });
    expect(response.statusCode).toBe(200);
    expect(remove).toHaveBeenCalledWith(INTERNAL_ID, NS_A);
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      type: "workspace.artifact.deleted",
      artifactId: TEMPLATE_ID,
      namespaceIds: [NS_A],
    });
  });

  test("retains the byte claim when the Artifact transaction fails so a retry can adopt it", async () => {
    const root = await mkdtemp(join(tmpdir(), "slides-template-orphan-"));
    tempRoots.push(root);
    let committed: Artifact | null = null;
    let commitEnabled = false;
    const dependencies = {
      artifactsRoot: () => root,
      write: async (path: string, content: string) => writeFile(path, content, { encoding: "utf8", flag: "wx" }),
      remove: async (path: string) => rm(path, { force: true }),
      transaction: async () => { throw new Error("database unavailable"); },
      commit: async () => {
        if (!commitEnabled) throw new Error("database unavailable");
        committed = { ...artifact(TEMPLATE_ID, "Orphan"), storageUri: `file://${join(root, TEMPLATE_ID)}` };
        return committed;
      },
      findCreated: async () => committed ? { artifact: committed, namespaceIds: [NS_A] } : null,
    };
    expect(persistSlideTemplateArtifact({
      templateId: TEMPLATE_ID,
      name: "Orphan",
      content: CONTENT,
      namespaceId: NS_A,
    }, dependencies)).rejects.toThrow("database unavailable");
    expect(await readdir(root)).toEqual([TEMPLATE_ID]);
    commitEnabled = true;
    expect((await persistSlideTemplateArtifact({ templateId: TEMPLATE_ID, name: "Orphan", content: CONTENT, namespaceId: NS_A }, dependencies)).artifactId).toBe(TEMPLATE_ID);
  });

  test("concurrent same-identity orphan adopters converge without deleting shared bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "slides-template-concurrent-"));
    tempRoots.push(root);
    let committed: Artifact | null = null;
    let commits = 0;
    await writeFile(join(root, TEMPLATE_ID), CONTENT);
    let bothAdopters!: () => void;
    const ready = new Promise<void>((resolve) => { bothAdopters = resolve; });
    const remove = mock(async (path: string) => rm(path, { force: true }));
    const dependencies = {
      artifactsRoot: () => root,
      write: async (path: string, content: string) => writeFile(path, content, { encoding: "utf8", flag: "wx" }),
      read: async (path: string) => readFile(path, "utf8"),
      remove,
      transaction: async () => { throw new Error("unused"); },
      findCreated: async () => committed ? { artifact: committed, namespaceIds: [NS_A] } : null,
      commit: async () => {
        commits += 1;
        if (commits === 2) bothAdopters();
        await ready;
        if (committed) throw new Error("unique artifact identity conflict");
        committed = { ...artifact(TEMPLATE_ID, "Concurrent"), storageUri: `file://${join(root, TEMPLATE_ID)}` };
        return committed;
      },
    };
    const input = { templateId: TEMPLATE_ID, name: "Concurrent", content: CONTENT, namespaceId: NS_A };
    const [first, second] = await Promise.all([
      persistSlideTemplateArtifact(input, dependencies),
      persistSlideTemplateArtifact(input, dependencies),
    ]);
    expect(first.artifactId).toBe(TEMPLATE_ID);
    expect(second).toEqual(first);
    expect(commits).toBe(2);
    expect(await readFile(join(root, TEMPLATE_ID), "utf8")).toBe(CONTENT);
    expect(remove).not.toHaveBeenCalled();
  });

  test("does not remove preexisting bytes when exclusive creation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "slides-template-existing-"));
    tempRoots.push(root);
    const path = join(root, TEMPLATE_ID);
    await writeFile(path, "preexisting", "utf8");
    const remove = mock(async (candidate: string) => rm(candidate, { force: true }));
    const transaction = mock(async () => { throw new Error("must not run"); });
    const findCreated = mock(async () => null);

    expect(persistSlideTemplateArtifact({
      templateId: TEMPLATE_ID,
      name: "Collision",
      content: CONTENT,
      namespaceId: NS_A,
    }, {
      artifactsRoot: () => root,
      write: async (candidate, content) => writeFile(candidate, content, { encoding: "utf8", flag: "wx" }),
      remove,
      transaction,
      findCreated,
    })).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("preexisting");
    expect(remove).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(findCreated).toHaveBeenCalledTimes(1);
  });

  test("reconciles a committed Artifact after its transaction acknowledgement is lost", async () => {
    const root = await mkdtemp(join(tmpdir(), "slides-template-committed-"));
    tempRoots.push(root);
    const committed = {
      ...artifact(TEMPLATE_ID, "Committed"),
      storageUri: `file://${join(root, TEMPLATE_ID)}`,
    };
    const remove = mock(async (candidate: string) => rm(candidate, { force: true }));

    const reconciled = await persistSlideTemplateArtifact({
      templateId: TEMPLATE_ID,
      name: "Committed",
      content: CONTENT,
      namespaceId: NS_A,
    }, {
      artifactsRoot: () => root,
      write: async (candidate, content) => writeFile(candidate, content, { encoding: "utf8", flag: "wx" }),
      remove,
      transaction: async () => { throw new Error("commit acknowledgement lost"); },
      findCreated: async () => ({ artifact: committed, namespaceIds: [NS_A] }),
    });
    expect(reconciled).toEqual(committed);
    expect(await readFile(join(root, TEMPLATE_ID), "utf8")).toBe(CONTENT);
    expect(remove).not.toHaveBeenCalled();
  });

  test("retains owned bytes when transaction reconciliation is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "slides-template-uncertain-"));
    tempRoots.push(root);
    const remove = mock(async (candidate: string) => rm(candidate, { force: true }));

    expect(persistSlideTemplateArtifact({
      templateId: TEMPLATE_ID,
      name: "Uncertain",
      content: CONTENT,
      namespaceId: NS_A,
    }, {
      artifactsRoot: () => root,
      write: async (candidate, content) => writeFile(candidate, content, { encoding: "utf8", flag: "wx" }),
      remove,
      transaction: async () => { throw new Error("commit acknowledgement lost"); },
      findCreated: async () => { throw new Error("lookup unavailable"); },
    })).rejects.toThrow("commit acknowledgement lost");
    expect(await readFile(join(root, TEMPLATE_ID), "utf8")).toBe(CONTENT);
    expect(remove).not.toHaveBeenCalled();
  });

  test("retains bytes when a committed Artifact moved scope or was deleted before reconciliation", async () => {
    for (const state of ["moved", "deleted"] as const) {
      const root = await mkdtemp(join(tmpdir(), `slides-template-${state}-`));
      tempRoots.push(root);
      const committed = {
        ...artifact(TEMPLATE_ID, "Changed"),
        storageUri: `file://${join(root, TEMPLATE_ID)}`,
        ...(state === "moved"
          ? { path: "Elsewhere/moved.slide-template.html" }
          : { deletedAt: new Date("2026-09-11T12:00:00.000Z") }),
      };
      const remove = mock(async (candidate: string) => rm(candidate, { force: true }));

      expect(persistSlideTemplateArtifact({
        templateId: TEMPLATE_ID,
        name: "Changed",
        content: CONTENT,
        namespaceId: NS_A,
      }, {
        artifactsRoot: () => root,
        write: async (candidate, content) => writeFile(candidate, content, { encoding: "utf8", flag: "wx" }),
        remove,
        transaction: async () => { throw new Error("commit acknowledgement lost"); },
        findCreated: async () => ({
          artifact: committed,
          namespaceIds: state === "moved" ? [NS_B] : [NS_A],
        }),
      })).rejects.toThrow("commit acknowledgement lost");
      expect(await readFile(join(root, TEMPLATE_ID), "utf8")).toBe(CONTENT);
      expect(remove).not.toHaveBeenCalled();
    }
  });
});


test("private template byte publication is complete and exclusive", async () => {
  const root = await mkdtemp(join(tmpdir(), "slides-template-publication-"));
  try {
    const path = join(root, TEMPLATE_ID);
    await writeSlideTemplateBytes(path, CONTENT);
    expect(await readFile(path, "utf8")).toBe(CONTENT);
    expect(await readdir(root)).toEqual([TEMPLATE_ID]);
    expect(await writeSlideTemplateBytes(path, "conflicting bytes").then(() => "unexpected success", () => "refused")).toBe("refused");
    expect(await readFile(path, "utf8")).toBe(CONTENT);
    expect(await readdir(root)).toEqual([TEMPLATE_ID]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
