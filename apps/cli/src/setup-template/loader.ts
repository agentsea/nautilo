import { readFileSync, statSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import {
  SetupTemplateV1,
  type SetupTemplate,
  type SecretField,
} from "@nautilo/api-client";

class EnvVarMissingError extends Error {
  constructor(
    public readonly field: string,
    public readonly varName: string,
  ) {
    super(`EnvVarMissingError(field=${field}, var=${varName})`);
    this.name = "EnvVarMissingError";
  }
}

/** Fully-resolved template (no `fromEnv` unions left). */
export type ResolvedSetupTemplate = Omit<SetupTemplate, "admin" | "claim" | "providers"> & {
  admin: Omit<SetupTemplate["admin"], "password" | "pin"> & {
    password: { value: string };
    pin: { value: string };
  };
  claim: { inviteCode: { value: string } };
  providers: Array<{ key: string; value: { value: string } }>;
};

export type EnvLookup = (varName: string) => string | undefined;

function resolveSecret(
  fieldPath: string,
  field: SecretField,
  lookup: EnvLookup,
): { value: string } {
  if ("value" in field) {
    return { value: field.value };
  }
  const v = lookup(field.fromEnv)?.trim();
  if (!v) {
    throw new EnvVarMissingError(fieldPath, field.fromEnv);
  }
  return { value: v };
}

function assertSetupFileMode600(filePath: string): void {
  if (process.platform === "win32") return;
  const st = statSync(filePath);
  const mode = st.mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(
      "setup file must be chmod 600 (contains a password).",
    );
  }
}

export function parseSetupTemplateFromPath(filePath: string): SetupTemplate {
  assertSetupFileMode600(filePath);
  const raw = readFileSync(filePath, "utf8");
  const lower = filePath.toLowerCase();
  const parsed: unknown =
    lower.endsWith(".json") ? JSON.parse(raw) : parseToml(raw);

  if (typeof parsed === "object" && parsed !== null) {
    const sv = (parsed as Record<string, unknown>)["schemaVersion"];
    if (sv !== undefined && sv !== 1) {
      throw new Error(
        `unsupported template schema version (expected 1, got ${JSON.stringify(sv)})`,
      );
    }
  }

  const validated = SetupTemplateV1.safeParse(parsed);
  if (!validated.success) {
    throw new Error(validated.error.message);
  }
  return validated.data;
}

export function resolveSetupTemplate(
  t: SetupTemplate,
  lookup: EnvLookup,
): ResolvedSetupTemplate {
  const password = resolveSecret("admin.password", t.admin.password, lookup);
  if (password.value.length < 8) {
    throw new Error("admin.password: value must be ≥ 8 characters when inlined");
  }

  const pin: { value: string } = t.admin.pin
    ? resolveSecret("admin.pin", t.admin.pin, lookup)
    : (() => {
        throw new Error("admin.pin is required in the setup template.");
      })();
  if (!/^\d{6,8}$/.test(pin.value)) {
    throw new Error("admin.pin must be 6–8 digits after resolution.");
  }

  const inviteCode = resolveSecret("claim.inviteCode", t.claim.inviteCode, lookup);

  const providers = t.providers.map((p, i) => ({
    key: p.key,
    value: resolveSecret(`providers[${i}].value`, p.value, lookup),
  }));

  return {
    ...t,
    admin: {
      ...t.admin,
      password,
      pin,
    },
    claim: {
      inviteCode,
    },
    providers,
  };
}


