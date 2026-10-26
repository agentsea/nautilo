import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { magentOperatorConfigSchema, magentOperatorManifestSchema, type MagentOperatorConfig } from "@nautilo/types";
import { readMagentPrivateJson, readMagentOperatorConfig, startMagentUnixHttp } from "./magent-unix";
import type { MagentOperatorService } from "./magent-operator";

/** Validate the complete private deployment before constructing services or opening sockets. */
export function validateMagentBindings(configs: MagentOperatorConfig[]): void {
  const ids = new Set<string>();
  const sockets = new Set<string>();
  const credentials = new Set<string>();
  const routes = new Set<string>();
  for (const config of configs) {
    const digest = createHash("sha256").update(config.credential).digest("hex");
    const route = JSON.stringify([config.origin, config.providerAgentId, config.chatId]);
    if (!isAbsolute(config.socketPath) || resolve(config.socketPath) !== config.socketPath) {
      throw new Error("magent_socket_path_invalid");
    }
    if (ids.has(config.operatorBindingId) || sockets.has(config.socketPath)
      || credentials.has(digest) || routes.has(route)) throw new Error("magent_binding_configuration_conflict");
    ids.add(config.operatorBindingId);
    sockets.add(config.socketPath);
    credentials.add(digest);
    routes.add(route);
  }
}

export async function readMagentBindings(path: string): Promise<MagentOperatorConfig[]> {
  const input = await readMagentPrivateJson(path);
  const single = magentOperatorConfigSchema.safeParse(input);
  if (single.success) {
    validateMagentBindings([single.data]);
    return [single.data];
  }
  const manifest = magentOperatorManifestSchema.safeParse(input);
  if (!manifest.success) throw new Error("magent_config_invalid");
  if (new Set(manifest.data.configFiles).size !== manifest.data.configFiles.length) {
    throw new Error("magent_binding_configuration_conflict");
  }
  const configs = await Promise.all(manifest.data.configFiles.map(readMagentOperatorConfig));
  validateMagentBindings(configs);
  return configs;
}

/** One fixed service and capability per socket; partial startup is always unwound. */
export async function startMagentBindings(
  configs: MagentOperatorConfig[],
  createService: (config: MagentOperatorConfig) => Promise<MagentOperatorService>,
  startSocket: (config: MagentOperatorConfig, service: MagentOperatorService) => Promise<{ close(): Promise<void> }> = startMagentUnixHttp,
) {
  validateMagentBindings(configs);
  const sockets: Array<{ close(): Promise<void> }> = [];
  async function close() {
    const results = await Promise.allSettled(sockets.map(socket => socket.close()));
    const failed = results.find(result => result.status === "rejected");
    if (failed) throw new Error("magent_socket_cleanup_failed");
  }
  try {
    // Construct all services before exposing any socket to local clients.
    const services = [];
    for (const config of configs) services.push(await createService(config));
    for (const [index, config] of configs.entries()) sockets.push(await startSocket(config, services[index]!));
    return { close };
  } catch {
    await close();
    // Startup errors can carry filesystem or adapter details; keep the public error opaque.
    throw new Error("magent_bindings_start_failed");
  }
}
