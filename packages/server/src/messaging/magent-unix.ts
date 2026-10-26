import { constants } from "node:fs";
import { chmod, lstat, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { createConnection } from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import { z } from "zod";
import { magentOperatorConfigSchema, magentTurnRequestSchema, magentPublicationClaimSchema,
  magentPublicationSettlementSchema, type MagentOperatorConfig } from "@nautilo/types";
import type { MagentOperatorService } from "./magent-operator";

export async function readMagentPrivateJson(path: string): Promise<unknown> {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) throw new Error("magent_config_path_invalid");
  const parent = dirname(path);
  for (let directory = parent; ; directory = dirname(directory)) {
    const stat = await lstat(directory);
    const owned = stat.uid === process.getuid?.();
    // A dedicated private parent protects the file name from other users.
    // Higher ancestors may be root-owned; only root-owned sticky temporary
    // directories may permit other users to create entries.
    const rootSticky = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (directory === parent ? !owned || (stat.mode & 0o077) !== 0
        : (!owned && stat.uid !== 0) || ((stat.mode & 0o022) !== 0 && !rootSticky))) {
      throw new Error("magent_config_directory_invalid");
    }
    if (directory === dirname(directory)) break;
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error("magent_config_permissions_invalid");
    return JSON.parse(await file.readFile("utf8")) as unknown;
  } catch {
    // Never include a credential-bearing configuration or validation payload in logs.
    throw new Error("magent_config_invalid");
  } finally { await file.close(); }
}

export async function readMagentOperatorConfig(path: string): Promise<MagentOperatorConfig> {
  const result = magentOperatorConfigSchema.safeParse(await readMagentPrivateJson(path));
  if (!result.success) throw new Error("magent_config_invalid");
  return result.data;
}

/** Independently testable routes. This server is never registered on the public HTTP listener. */
export function createMagentUnixHttp(config: Pick<MagentOperatorConfig, "credential" | "maxRequestBytes">, service: MagentOperatorService) {
  const app = Fastify({ logger: false, bodyLimit: config.maxRequestBytes });
  const expected = createHash("sha256").update(`Bearer ${config.credential}`).digest();
  app.addHook("onRequest", async (request, reply) => {
    const actual = createHash("sha256").update(request.headers.authorization ?? "").digest();
    if (!timingSafeEqual(expected, actual)) return reply.code(401).send({ error: "unauthorized" });
  });
  app.setErrorHandler((_error, _request, reply) => { void reply.code(400).send({ error: "request_unavailable" }); });
  const params = z.object({ id: z.uuid() }).strict();
  const sendResult = (result: unknown, reply: import("fastify").FastifyReply) => result === null
    ? reply.code(409).send({ error: "authority_or_state_unavailable" }) : reply.send(result);
  app.get("/v1/status", () => service.status());
  app.get("/v1/avatar", async (request, reply) => {
    z.object({}).strict().parse(request.query);
    const avatar = await service.avatar();
    reply.header("cache-control", "no-store");
    if (avatar === null) return sendResult(null, reply);
    if (avatar.status === "absent") return reply.code(404).send({ error: "avatar_absent" });
    return reply.type(avatar.contentType).send(Buffer.from(avatar.bytes));
  });
  app.post("/v1/turns", async (request, reply) => sendResult(await service.accept(magentTurnRequestSchema.parse(request.body)), reply));
  app.get("/v1/turns/:id", async (request, reply) => sendResult(await service.receipt(params.parse(request.params).id), reply));
  app.delete("/v1/turns/:id", async (request, reply) => sendResult(await service.cancel(params.parse(request.params).id), reply));
  app.post("/v1/publications/:id/claim", async (request, reply) => sendResult(await service.claim(
    params.parse(request.params).id, magentPublicationClaimSchema.parse(request.body).claimToken), reply));
  app.post("/v1/publications/:id/authorize", async (request, reply) => sendResult(await service.authorize(
    params.parse(request.params).id, magentPublicationClaimSchema.parse(request.body).claimToken), reply));
  app.post("/v1/publications/:id/settle", async (request, reply) => sendResult(await service.settle(
    params.parse(request.params).id, magentPublicationSettlementSchema.parse(request.body)), reply));
  app.post("/v1/binding/pause", async (_request, reply) => sendResult(await service.withdraw("paused"), reply));
  app.post("/v1/binding/revoke", async (_request, reply) => sendResult(await service.withdraw("revoked"), reply));
  return app;
}

async function prepareSocket(path: string) {
  if (!isAbsolute(path)) throw new Error("magent_socket_path_invalid");
  const directory = dirname(path);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()
    || await realpath(directory) !== resolve(directory)) throw new Error("magent_socket_directory_invalid");
  const previous = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!previous) return;
  if (!previous.isSocket() || previous.uid !== stat.uid) throw new Error("magent_socket_path_occupied");
  const refused = await new Promise<boolean>((resolveProbe, reject) => {
    const probe = createConnection(path);
    probe.once("connect", () => { probe.destroy(); resolveProbe(false); });
    probe.once("error", (error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED" ? resolveProbe(true) : reject(error));
  });
  if (!refused) throw new Error("magent_socket_already_active");
  const current = await lstat(path);
  if (current.dev !== previous.dev || current.ino !== previous.ino) throw new Error("magent_socket_changed");
  await unlink(path);
}

export async function startMagentUnixHttp(config: MagentOperatorConfig, service: MagentOperatorService) {
  await prepareSocket(config.socketPath);
  const app = createMagentUnixHttp(config, service);
  try {
    await app.listen({ path: config.socketPath });
    await chmod(config.socketPath, 0o600);
    return app;
  } catch (error) { await app.close(); throw error; }
}
