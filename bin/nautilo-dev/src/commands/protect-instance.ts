import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { parse, stringify } from "smol-toml";
import {
  resolveNautiloStorageRoot,
  validateNautiloInstanceIdValue,
} from "@nautilo/config";
import { protectDurableInstance } from "../lib/protected-durable-instance";

function writeProfileAtomically(path: string, value: Record<string, unknown>, expectedRaw: string | null): void {
  const temporary = `${path}.protect-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, stringify(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(temporary, 0o600);
    if (expectedRaw === null) {
      if (existsSync(path)) throw new Error("profile appeared concurrently");
    } else {
      const current = lstatSync(path);
      if (!current.isFile() || current.isSymbolicLink() || readFileSync(path, "utf8") !== expectedRaw) {
        throw new Error("profile changed concurrently");
      }
    }
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** Persist protection outside the instance root so root recreation cannot drop it. */
export function persistLocalProfileRetention(
  home: string,
  id: string,
  retention: "durable" | "disposable",
): void {
  const profilesRoot = join(home, ".nautilo", "profiles");
  const nautiloRoot = join(home, ".nautilo");
  if (existsSync(nautiloRoot) && (!lstatSync(nautiloRoot).isDirectory() || lstatSync(nautiloRoot).isSymbolicLink())) {
    throw new Error("refusing non-directory or linked ~/.nautilo authority root");
  }
  mkdirSync(profilesRoot, { recursive: true, mode: 0o700 });
  if (!lstatSync(profilesRoot).isDirectory() || lstatSync(profilesRoot).isSymbolicLink()) {
    throw new Error("refusing non-directory or linked profiles authority root");
  }
  const matches: Array<{ path: string; raw: string; value: Record<string, unknown> }> = [];
  for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
    if (!entry.name.endsWith(".toml")) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`refusing non-regular profile '${entry.name}'`);
    const path = join(profilesRoot, entry.name);
    const raw = readFileSync(path, "utf8");
    let value: Record<string, unknown>;
    try {
      const parsed = parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid profile root");
      value = parsed as Record<string, unknown>;
    } catch {
      throw new Error(`refusing durable protection while profile '${entry.name}' is malformed`);
    }
    if (value["instance_id"] !== id) continue;
    if (value["transport"] !== "local" || value["lifecycle"] !== "compose") {
      throw new Error(`refusing durable protection because profile '${entry.name}' claims '${id}' without local Compose authority`);
    }
    if (retention === "disposable" && value["retention"] !== "disposable") {
      throw new Error(`refusing to downgrade profile '${entry.name}' from durable or legacy retention to disposable`);
    }
    matches.push({ path, raw, value });
  }
  if (matches.length === 0) {
    const path = join(profilesRoot, `${id}.toml`);
    if (existsSync(path)) throw new Error(`refusing to replace existing profile '${id}'`);
    writeProfileAtomically(path, { name: id, transport: "local", lifecycle: "compose", instance_id: id, retention }, null);
    return;
  }
  let updated = 0;
  for (const match of matches) {
    try {
      writeProfileAtomically(match.path, { ...match.value, retention }, match.raw);
      updated += 1;
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; ${updated} profile(s) were already updated and the remaining authority stays fail-closed`);
    }
  }
}

export function persistDurableProfileAuthority(home: string, id: string): void {
  persistLocalProfileRetention(home, id, "durable");
}

export function protectInstance(options: {
  readonly id: string;
  readonly userHomeDir?: string;
}): number {
  const id = options.id.trim();
  if (id === "") {
    console.error("[protect-instance] a named instance id is required.");
    return 1;
  }
  const validationError = validateNautiloInstanceIdValue(id);
  if (validationError !== null) {
    console.error(`[protect-instance] invalid id: ${validationError}`);
    return 1;
  }

  const home = options.userHomeDir?.trim() || homedir();
  const root = resolveNautiloStorageRoot(home, id);
  if (normalize(root) !== normalize(join(home, `.nautilo-${id}`))) {
    console.error("[protect-instance] path guard failed — aborting.");
    return 1;
  }

  const descriptorPath = join(root, "instance.json");
  if (!existsSync(descriptorPath)) {
    console.error(
      `[protect-instance] refusing unknown instance '${id}': missing instance.json`,
    );
    return 1;
  }
  try {
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8")) as {
      instanceId?: unknown;
    };
    if (descriptor.instanceId !== id) {
      console.error(
        `[protect-instance] refusing instance '${id}': instance.json identity does not match`,
      );
      return 1;
    }
  } catch {
    console.error(
      `[protect-instance] refusing instance '${id}': instance.json is not valid JSON`,
    );
    return 1;
  }

  try {
    persistDurableProfileAuthority(home, id);
    protectDurableInstance(root);
  } catch (error) {
    console.error(`[protect-instance] failed to persist durable authority: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  console.log(
    `[protect-instance] '${id}' is protected from cleanup and delete-instance.`,
  );
  return 0;
}
