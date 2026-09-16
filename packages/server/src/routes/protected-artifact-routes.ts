import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  protectedArtifactCiphertextStageResponseV1Schema,
  protectedArtifactAccessPlanRequestV1Schema,
  protectedArtifactAccessPlanResponseV1Schema,
  protectedArtifactAccessUpdateResponseV1Schema,
  protectedArtifactPreparedAccessRequestV1Schema,
  protectedArtifactDtoV1Schema,
  protectedArtifactListResponseV1Schema,
  protectedArtifactPreparedPublicationRequestV1Schema,
  protectedArtifactPublicationPlanRequestV1Schema,
  protectedArtifactPublicationPlanResponseV1Schema,
  protectedArtifactPublicationResponseV1Schema,
  protectedArtifactUnavailableResponseV1Schema,
} from "@nautilo/api-client";
import type { HumanArtifactRouteAuthority } from "@nautilo/lattice-bridge/server";

import {
  resolveProtectedArtifactComposition,
  type ProtectedArtifactComposition,
} from "./protected-artifact-composition";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^[A-Za-z0-9_-]{43}$/u;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const MAX_CIPHERTEXT_BYTES = 110_100_000;

function positiveSafeInteger(value: string, maximum: number): number | null {
  if (!/^[1-9][0-9]*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
}

function nonnegativeSafeInteger(value: string, maximum: number): number | null {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
}

type ResolveAuthorizedRequest = (
  request: FastifyRequest,
) => Promise<HumanArtifactRouteAuthority | null>;

function invalid(reply: FastifyReply) {
  return reply.code(400).send({ error: "Exact protected Artifact request required" });
}

/** Explicit dormant registration. `app.ts` and ordinary Artifact routes do not call it. */
export function protectedArtifactRoutes(app: FastifyInstance, input: Readonly<{
  composition: ProtectedArtifactComposition;
  resolveAuthorizedRequest: ResolveAuthorizedRequest;
}>): void {
  app.addContentTypeParser(
    "application/vnd.nautilo.artifact-blob-v1",
    (_request, payload, done) => done(null, payload),
  );
  const resolve = async (request: FastifyRequest) => {
    const authority = await input.resolveAuthorizedRequest(request);
    if (authority === null) return null;
    const ports = resolveProtectedArtifactComposition({
      composition: input.composition,
      authority,
    });
    return ports === null ? null : Object.freeze({ authority, ports });
  };

  app.get("/api/protected/artifacts", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const fields = Object.keys(query);
    if (fields.some((field) => !["cursor", "limit", "includeArchive"].includes(field))) {
      return invalid(reply);
    }
    const cursor = query["cursor"];
    const rawLimit = query["limit"];
    const includeArchive = query["includeArchive"];
    const limit = typeof rawLimit === "string"
      ? positiveSafeInteger(rawLimit, 100)
      : undefined;
    if (
      (cursor !== undefined && (typeof cursor !== "string" || !UUID.test(cursor)))
      || (rawLimit !== undefined && limit === null)
      || (includeArchive !== undefined && includeArchive !== "true")
    ) return invalid(reply);
    const authorized = await resolve(request);
    if (authorized === null) return reply.code(403).send({ error: "Forbidden" });
    const result = await authorized.ports.list({
      authority: authorized.authority,
      ...(cursor === undefined ? {} : { cursor }),
      ...(limit === undefined || limit === null ? {} : { limit }),
      ...(includeArchive === "true" ? { includeArchive: true } : {}),
    });
    return reply.send(("reason" in result
      ? protectedArtifactUnavailableResponseV1Schema
      : protectedArtifactListResponseV1Schema).parse(result));
  });

  app.get("/api/protected/artifacts/:artifactId", async (
    request: FastifyRequest<{ Params: { artifactId: string } }>,
    reply,
  ) => {
    if (!UUID.test(request.params.artifactId)) return invalid(reply);
    const authorized = await resolve(request);
    if (authorized === null) return reply.code(403).send({ error: "Forbidden" });
    const result = await authorized.ports.detail({
      authority: authorized.authority,
      artifactId: request.params.artifactId,
    });
    return reply.send(("reason" in result
      ? protectedArtifactUnavailableResponseV1Schema
      : protectedArtifactDtoV1Schema).parse(result));
  });

  app.get("/api/protected/artifacts/:artifactId/ciphertext", async (
    request: FastifyRequest<{
      Params: { artifactId: string };
      Querystring: { start?: string; endExclusive?: string };
    }>,
    reply,
  ) => {
    const fields = Object.keys(request.query as object);
    const start = typeof request.query.start === "string"
      ? nonnegativeSafeInteger(request.query.start, Number.MAX_SAFE_INTEGER)
      : null;
    const endExclusive = typeof request.query.endExclusive === "string"
      ? nonnegativeSafeInteger(request.query.endExclusive, Number.MAX_SAFE_INTEGER)
      : null;
    if (
      !UUID.test(request.params.artifactId)
      || fields.length !== 2
      || fields.some((field) => !["start", "endExclusive"].includes(field))
      || start === null
      || endExclusive === null
      || endExclusive < start
      || endExclusive - start > 1_048_576
    ) return invalid(reply);
    const authorized = await resolve(request);
    if (authorized === null) return reply.code(403).send({ error: "Forbidden" });
    const result = await authorized.ports.ciphertextRange({
      authority: authorized.authority,
      artifactId: request.params.artifactId,
      start,
      endExclusive,
    });
    if ("reason" in result) {
      return reply.send(protectedArtifactUnavailableResponseV1Schema.parse(result));
    }
    const body = Buffer.from(result.body);
    result.body.fill(0);
    return reply
      .header("Content-Type", "application/vnd.nautilo.artifact-blob-range-v1")
      .header("X-Nautilo-Artifact-Id", result.artifactId)
      .header("X-Nautilo-Artifact-Revision", String(result.artifactRevision))
      .header("X-Nautilo-Crypto-Access-Revision", String(result.cryptoAccessRevision))
      .header("X-Nautilo-Blob-Id", result.blobId)
      .header("X-Nautilo-Blob-Generation", String(result.blobGeneration))
      .header("X-Nautilo-Plaintext-Length", String(result.plaintextLength))
      .header("X-Nautilo-Ciphertext-Length", String(result.ciphertextLength))
      .header("X-Nautilo-Ciphertext-SHA256", Buffer.from(
        result.ciphertextSha256,
      ).toString("base64url"))
      .header("X-Nautilo-Chunk-Plaintext-Bytes", String(result.chunkPlaintextBytes))
      .header("X-Nautilo-Chunk-Count", String(result.chunkCount))
      .header("X-Nautilo-First-Chunk-Index", String(result.firstChunkIndex))
      .header("X-Nautilo-Returned-Chunk-Count", String(result.returnedChunkCount))
      .send(body);
  });

  app.post("/api/protected/artifacts/publication-plan", async (request, reply) => {
    const body = protectedArtifactPublicationPlanRequestV1Schema.safeParse(request.body);
    if (!body.success) return invalid(reply);
    const authorized = await resolve(request);
    if (authorized === null) return reply.code(403).send({ error: "Forbidden" });
    const result = await authorized.ports.plan({
      authority: authorized.authority,
      request: body.data,
    });
    return reply.send(protectedArtifactPublicationPlanResponseV1Schema.parse(result));
  });

  app.put("/api/protected/artifacts/:artifactId/ciphertext/:operationId", async (
    request: FastifyRequest<{
      Params: { artifactId: string; operationId: string };
    }>,
    reply,
  ) => {
    const { artifactId, operationId } = request.params;
    const blobId = request.headers["x-nautilo-blob-id"];
    const generation = request.headers["x-nautilo-blob-generation"];
    const length = request.headers["content-length"];
    const digest = request.headers["x-nautilo-ciphertext-sha256"];
    const parsedGeneration = typeof generation === "string"
      ? positiveSafeInteger(generation, Number.MAX_SAFE_INTEGER)
      : null;
    const parsedLength = typeof length === "string"
      ? positiveSafeInteger(length, MAX_CIPHERTEXT_BYTES)
      : null;
    if (
      !UUID.test(artifactId)
      || typeof operationId !== "string" || operationId.length > 128
      || !PORTABLE_ID.test(operationId)
      || typeof blobId !== "string" || !UUID.test(blobId)
      || parsedGeneration === null
      || parsedLength === null
      || typeof digest !== "string" || !DIGEST.test(digest)
      || request.body === null
      || typeof request.body !== "object"
      || !(Symbol.asyncIterator in request.body)
    ) return invalid(reply);
    const authorized = await resolve(request);
    if (authorized === null) return reply.code(403).send({ error: "Forbidden" });
    const result = await authorized.ports.stageCiphertext({
      authority: authorized.authority,
      artifactId,
      operationId,
      blobId,
      blobGeneration: parsedGeneration,
      ciphertextLength: parsedLength,
      ciphertextSha256: new Uint8Array(Buffer.from(digest, "base64url")),
      ciphertext: request.body as AsyncIterable<Uint8Array>,
    });
    return reply.send(("reason" in result
      ? protectedArtifactUnavailableResponseV1Schema
      : protectedArtifactCiphertextStageResponseV1Schema).parse(result));
  });

  app.post("/api/protected/artifacts/:artifactId/publication", async (
    request: FastifyRequest<{ Params: { artifactId: string } }>,
    reply,
  ) => {
    if (!UUID.test(request.params.artifactId)) return invalid(reply);
    const body = protectedArtifactPreparedPublicationRequestV1Schema.safeParse(request.body);
    if (!body.success || body.data.artifactId !== request.params.artifactId) {
      return invalid(reply);
    }
    const authorized = await resolve(request);
    if (authorized === null) return reply.code(403).send({ error: "Forbidden" });
    const result = await authorized.ports.publish({
      authority: authorized.authority,
      prepared: body.data,
    });
    return reply.send(("reason" in result
      ? protectedArtifactUnavailableResponseV1Schema
      : protectedArtifactPublicationResponseV1Schema).parse(result));
  });

  app.post("/api/protected/artifacts/:artifactId/access-plan", async (
    request: FastifyRequest<{ Params: { artifactId: string } }>,
    reply,
  ) => {
    if (!UUID.test(request.params.artifactId)) return invalid(reply);
    const body = protectedArtifactAccessPlanRequestV1Schema.safeParse(request.body);
    if (!body.success) return invalid(reply);
    const authorized = await resolve(request);
    if (authorized === null) return reply.code(403).send({ error: "Forbidden" });
    const result = await authorized.ports.planAccess({
      authority: authorized.authority,
      artifactId: request.params.artifactId,
      operation: body.data.operation,
    });
    return reply.send(protectedArtifactAccessPlanResponseV1Schema.parse(result));
  });

  app.post("/api/protected/artifacts/:artifactId/access", async (
    request: FastifyRequest<{ Params: { artifactId: string } }>,
    reply,
  ) => {
    if (!UUID.test(request.params.artifactId)) return invalid(reply);
    const body = protectedArtifactPreparedAccessRequestV1Schema.safeParse(request.body);
    if (!body.success || body.data.artifactId !== request.params.artifactId) {
      return invalid(reply);
    }
    const authorized = await resolve(request);
    if (authorized === null) return reply.code(403).send({ error: "Forbidden" });
    const result = await authorized.ports.commitAccess({
      authority: authorized.authority,
      artifactId: request.params.artifactId,
      prepared: body.data,
    });
    return reply.send(("reason" in result
      ? protectedArtifactUnavailableResponseV1Schema
      : protectedArtifactAccessUpdateResponseV1Schema).parse(result));
  });
}
