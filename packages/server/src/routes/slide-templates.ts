import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Artifact } from "@nautilo/db";
import type { SlideTemplateContentDto, SlideTemplateListPageDto, SlideTemplateSummaryDto } from "@nautilo/api-client";
import { MAX_DOCUMENT_BYTES } from "@nautilo/writer-proposal-core";
import { requireArtifactWrite } from "../lib/artifact-write-admission";
import {
  decodeSlideTemplateCursor, defaultSlideTemplateService, encodeCursor, isRecord,
  normalizeTemplateName, requireExactTemplate, SLIDE_TEMPLATE_PAGE_BATCH,
  SLIDE_TEMPLATE_REQUEST_BODY_MAX_BYTES, templatePath, templateSummary,
  validTemplateContent, type SlideTemplateRouteService,
} from "../lib/slide-template-service";
export * from "../lib/slide-template-service";

async function requireTemplateScope(request: FastifyRequest, reply: FastifyReply, service: SlideTemplateRouteService): Promise<{ userId: string; namespaceId: string } | null> {
  const session = request as FastifyRequest & { sessionUserId?: string | null; sessionActorId?: string | null };
  const userId = session.sessionUserId;
  const actorId = session.sessionActorId;
  if (!userId || !actorId) { reply.code(401).send({ error: "Authentication required" }); return null; }
  const namespaceId = await service.resolvePrivateNamespace(userId, actorId);
  if (!namespaceId) { reply.code(409).send({ error: "Your private Workspace is unavailable. Reconnect and try again.", code: "private_template_scope_unavailable" }); return null; }
  return { userId, namespaceId };
}
export function slideTemplateRoutes(
  app: FastifyInstance,
  overrides: Partial<SlideTemplateRouteService> = {},
): void {
  const service: SlideTemplateRouteService = { ...defaultSlideTemplateService, ...overrides };
  const collectionPath = "/api/apps/nautilo-presentation/slide-templates";

  app.get(collectionPath, async (request, reply) => {
    const scope = await requireTemplateScope(request, reply, service);
    if (!scope) return;
    const rawCursor = (request.query as { cursor?: unknown }).cursor;
    const cursor = rawCursor === undefined
      ? undefined
      : decodeSlideTemplateCursor(rawCursor, scope.userId, scope.namespaceId);
    if (rawCursor !== undefined && !cursor) {
      return reply.code(400).send({ error: "Invalid template cursor" });
    }
    const rows = await service.listPage({
      namespaceId: scope.namespaceId,
      pageSize: SLIDE_TEMPLATE_PAGE_BATCH + 1,
      ...(cursor ? { cursor } : {}),
    });
    const hasNext = rows.length > SLIDE_TEMPLATE_PAGE_BATCH;
    const rawPage = rows.slice(0, SLIDE_TEMPLATE_PAGE_BATCH);
    const visible = rawPage
      .map((artifact) => ({ artifact, summary: templateSummary(artifact) }))
      .filter((entry): entry is { artifact: Artifact; summary: SlideTemplateSummaryDto } =>
        entry.summary !== null);
    const last = rawPage.at(-1);
    const body: SlideTemplateListPageDto = {
      templates: visible.map((entry) => entry.summary),
      nextCursor: hasNext && last
        ? encodeCursor(last, scope.userId, scope.namespaceId)
        : null,
    };
    return reply.send(body);
  });

  app.get(`${collectionPath}/:templateId`, async (request, reply) => {
    const scope = await requireTemplateScope(request, reply, service);
    if (!scope) return;
    const { templateId } = request.params as { templateId: string };
    const found = await requireExactTemplate(templateId, scope.namespaceId, service);
    if (!found) return reply.code(404).send({ error: "Template not found" });
    let content: string;
    try {
      content = await service.read(found.artifact.storageUri);
    } catch {
      return reply.code(404).send({ error: "Template not found" });
    }
    if (!validTemplateContent(content)) {
      return reply.code(422).send({ error: "Template content is invalid" });
    }
    const body: SlideTemplateContentDto = { content };
    return reply.send(body);
  });

  app.post(collectionPath, { bodyLimit: SLIDE_TEMPLATE_REQUEST_BODY_MAX_BYTES }, async (request, reply) => {
    const scope = await requireTemplateScope(request, reply, service);
    if (!scope) return;
    if (
      !isRecord(request.body) ||
      Object.keys(request.body).length !== 2 ||
      !Object.hasOwn(request.body, "name") ||
      !Object.hasOwn(request.body, "content")
    ) return reply.code(400).send({ error: "Template request is invalid" });
    const body = request.body;
    const name = normalizeTemplateName(body["name"]);
    if (!name) return reply.code(400).send({ error: "Template name is required" });
    if (!validTemplateContent(body["content"])) {
      const tooLarge = typeof body["content"] === "string" &&
        Buffer.byteLength(body["content"], "utf8") > MAX_DOCUMENT_BYTES;
      return reply.code(tooLarge ? 413 : 400).send({ error: "Template content is invalid" });
    }
    const templateId = randomUUID();
    if (templatePath(templateId, name) === null) {
      return reply.code(400).send({ error: "Template name is too long" });
    }
    if (!(await requireArtifactWrite({
      humanUserId: scope.userId,
      namespaceId: scope.namespaceId,
    }, reply, service.assertCanWriteArtifacts))) return;

    let created: Artifact;
    try {
      created = await service.persist({
        templateId,
        name,
        content: body["content"],
        namespaceId: scope.namespaceId,
      });
    } catch {
      return reply.code(500).send({ error: "Template could not be saved" });
    }
    service.publish({
      type: "workspace.artifact.changed",
      id: created.id,
      artifactId: created.artifactId,
      path: created.path,
    });
    return reply.code(201).send({ id: created.artifactId, name } satisfies SlideTemplateSummaryDto);
  });

  app.delete(`${collectionPath}/:templateId`, async (request, reply) => {
    const scope = await requireTemplateScope(request, reply, service);
    if (!scope) return;
    const { templateId } = request.params as { templateId: string };
    const found = await requireExactTemplate(templateId, scope.namespaceId, service);
    if (!found) return reply.code(404).send({ error: "Template not found" });
    if (!(await requireArtifactWrite({
      humanUserId: scope.userId,
      artifactId: found.artifact.id,
      namespaceId: scope.namespaceId,
    }, reply, service.assertCanWriteArtifacts))) return;
    const deleted = await service.remove(found.artifact.id, scope.namespaceId);
    if (!deleted) return reply.code(404).send({ error: "Template not found" });
    service.publish({
      type: "workspace.artifact.deleted",
      id: deleted.id,
      artifactId: deleted.artifactId,
      namespaceIds: [scope.namespaceId],
    });
    return reply.send({ ok: true });
  });
}
