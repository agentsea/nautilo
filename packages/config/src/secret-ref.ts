import type {
  ConnectionRef,
  ConnectionScope,
  VaultBackend,
} from "@nautilo/types";

const SECRET_PREFIX = "secret:";
const ENV_PREFIX = "env:";

export type ConfigValueRef =
  | { kind: "literal"; value: string }
  | { kind: "env"; name: string }
  | { kind: "secret"; ref: ConnectionRef; name: string };

export type ConfigSecretResolutionErrorCode =
  | "MALFORMED_SECRET_REF"
  | "MISSING_ENV"
  | "MISSING_VAULT"
  | "MISSING_SECRET";

export class ConfigSecretResolutionError extends Error {
  constructor(
    readonly code: ConfigSecretResolutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConfigSecretResolutionError";
  }
}

export function parseConfigValueRef(value: string): ConfigValueRef {
  if (value.startsWith(ENV_PREFIX)) {
    return { kind: "env", name: value.slice(ENV_PREFIX.length) };
  }
  if (!value.startsWith(SECRET_PREFIX)) {
    return { kind: "literal", value };
  }

  const name = value.slice(SECRET_PREFIX.length).trim();
  const ref = connectionRefFromSecretName(name);
  return { kind: "secret", name, ref };
}

export function connectionRefFromSecretName(name: string): ConnectionRef {
  if (!name || name.includes("/") || name.includes("\\") || /\s/.test(name)) {
    throw new ConfigSecretResolutionError(
      "MALFORMED_SECRET_REF",
      "secret reference must be service.field with no whitespace",
    );
  }

  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    throw new ConfigSecretResolutionError(
      "MALFORMED_SECRET_REF",
      "secret reference must be service.field",
    );
  }

  return {
    service: name.slice(0, dot),
    field: name.slice(dot + 1),
  };
}

export async function resolveConfigValueRef(
  value: string,
  deps: {
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly vault?: VaultBackend | null | undefined;
    readonly scope?: ConnectionScope | undefined;
  } = {},
): Promise<string> {
  const parsed = parseConfigValueRef(value);
  if (parsed.kind === "literal") return parsed.value;

  if (parsed.kind === "env") {
    const resolved = (deps.env ?? process.env)[parsed.name];
    if (resolved === undefined) {
      throw new ConfigSecretResolutionError(
        "MISSING_ENV",
        `missing env reference ${parsed.name}`,
      );
    }
    return resolved;
  }

  if (!deps.vault || !deps.scope) {
    throw new ConfigSecretResolutionError(
      "MISSING_VAULT",
      "secret references require a server-side vault and scope",
    );
  }

  const bytes = await deps.vault.get(parsed.ref, deps.scope);
  if (!bytes) {
    throw new ConfigSecretResolutionError(
      "MISSING_SECRET",
      `missing secret reference ${parsed.name}`,
    );
  }
  return Buffer.from(bytes).toString("utf8");
}

export function secretNameForConnection(ref: ConnectionRef): string {
  return `${ref.service}.${ref.field}`;
}

export function secretRefForConnection(ref: ConnectionRef): string {
  return `${SECRET_PREFIX}${secretNameForConnection(ref)}`;
}
