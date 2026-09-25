import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";

/** One versioned secret so key identity and bytes cannot be provisioned separately. */
export const PERSONAL_PROVIDER_CUSTODY_ENV = "NAUTILO_PERSONAL_PROVIDER_CUSTODY";

// A platform-injected value is captured before dotenv loads and removed from
// the ambient environment. Child processes must not inherit the key that can
// decrypt every Human's provider credential.
let injectedCustody: string | undefined;

export function captureInjectedPersonalProviderCustody(value: string | undefined): void {
  injectedCustody = value;
}

export function readInjectedPersonalProviderCustody(): string | undefined {
  return injectedCustody;
}

export interface PersonalProviderCustody {
  readonly formatVersion: 1;
  readonly keyId: string;
  readonly keyHex: string;
  /** Explicit disaster reset provenance; rows under this lost key stay blocked. */
  readonly resetFromKeyId?: string;
}

export interface PersonalProviderCredentialContext {
  readonly userId: string;
  readonly provider: string;
  readonly id: string;
  readonly revision: number;
}

export interface PersonalProviderCredentialEnvelope {
  readonly formatVersion: 1;
  readonly keyId: string;
  readonly nonceBase64: string;
  readonly ciphertextBase64: string;
  readonly authTagBase64: string;
}

export type PersonalProviderCustodyErrorCode =
  | "custody_missing" | "custody_invalid" | "custody_unavailable"
  | "custody_key_mismatch" | "credential_invalid" | "credential_authentication_failed";

export class PersonalProviderCustodyError extends Error {
  constructor(readonly code: PersonalProviderCustodyErrorCode) {
    super(`Personal provider credentials unavailable: ${code}`);
    this.name = "PersonalProviderCustodyError";
  }
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
// AES-256-GCM uses a 256-bit key, 96-bit nonce and 128-bit tag, as in push-token custody.
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function parsePersonalProviderCustody(raw: string | undefined): PersonalProviderCustody {
  if (raw === undefined) throw new PersonalProviderCustodyError("custody_missing");
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort().join(",");
    if ((keys !== "formatVersion,keyHex,keyId" && keys !== "formatVersion,keyHex,keyId,resetFromKeyId")
      || record["formatVersion"] !== 1
      || typeof record["keyId"] !== "string" || !UUID.test(record["keyId"])
      || typeof record["keyHex"] !== "string" || !/^[a-f0-9]{64}$/i.test(record["keyHex"])
      || (record["resetFromKeyId"] !== undefined && (typeof record["resetFromKeyId"] !== "string" || !UUID.test(record["resetFromKeyId"])))) throw new Error();
    const keyId = record["keyId"].toLowerCase();
    const resetFromKeyId = typeof record["resetFromKeyId"] === "string" ? record["resetFromKeyId"].toLowerCase() : undefined;
    if (resetFromKeyId === keyId) throw new Error();
    return {
      formatVersion: 1, keyId, keyHex: record["keyHex"].toLowerCase(),
      ...(resetFromKeyId === undefined ? {} : { resetFromKeyId }),
    };
  } catch {
    throw new PersonalProviderCustodyError("custody_invalid");
  }
}

export function createPersonalProviderCustody(): PersonalProviderCustody {
  return { formatVersion: 1, keyId: randomUUID(), keyHex: randomBytes(KEY_BYTES).toString("hex") };
}

export function serializePersonalProviderCustody(custody: PersonalProviderCustody): string {
  return JSON.stringify(parsePersonalProviderCustody(JSON.stringify(custody)));
}

function associatedData(context: PersonalProviderCredentialContext, keyId: string): Buffer {
  if (![context.userId, context.provider, context.id].every((s) => typeof s === "string" && s.length > 0)
    || !Number.isSafeInteger(context.revision) || context.revision < 1) {
    throw new PersonalProviderCustodyError("credential_invalid");
  }
  // JSON array encoding is unambiguous even if a caller supplies delimiter characters.
  return Buffer.from(JSON.stringify([
    "nautilo.personal-provider-credential.v1", keyId,
    context.userId, context.provider, context.id, context.revision,
  ]));
}

function decode(value: string, length?: number): Buffer {
  if (typeof value !== "string" || !value.length) throw new PersonalProviderCustodyError("credential_invalid");
  const result = Buffer.from(value, "base64");
  if (result.toString("base64") !== value || (length !== undefined && result.length !== length)) {
    throw new PersonalProviderCustodyError("credential_invalid");
  }
  return result;
}

export function encryptPersonalProviderCredential(
  custody: PersonalProviderCustody,
  plaintext: string,
  context: PersonalProviderCredentialContext,
): PersonalProviderCredentialEnvelope {
  const validated = parsePersonalProviderCustody(JSON.stringify(custody));
  if (typeof plaintext !== "string" || !plaintext.length) throw new PersonalProviderCustodyError("credential_invalid");
  const key = Buffer.from(validated.keyHex, "hex");
  try {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(associatedData(context, validated.keyId));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      formatVersion: 1, keyId: validated.keyId, nonceBase64: nonce.toString("base64"),
      ciphertextBase64: ciphertext.toString("base64"), authTagBase64: cipher.getAuthTag().toString("base64"),
    };
  } finally { key.fill(0); }
}

export function decryptPersonalProviderCredential(
  custody: PersonalProviderCustody,
  envelope: PersonalProviderCredentialEnvelope,
  context: PersonalProviderCredentialContext,
): string {
  const validated = parsePersonalProviderCustody(JSON.stringify(custody));
  if (envelope.formatVersion !== 1) throw new PersonalProviderCustodyError("credential_invalid");
  if (envelope.keyId !== validated.keyId) throw new PersonalProviderCustodyError("custody_key_mismatch");
  const key = Buffer.from(validated.keyHex, "hex");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, decode(envelope.nonceBase64, NONCE_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(associatedData(context, envelope.keyId));
    decipher.setAuthTag(decode(envelope.authTagBase64, TAG_BYTES));
    const ciphertext = decode(envelope.ciphertextBase64);
    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new PersonalProviderCustodyError("credential_authentication_failed");
    }
  } finally { key.fill(0); }
}

/** Read exactly this secret from a canonical dotenv file without treating blank as absent. */
export function personalProviderCustodyFromEnvFile(raw: string): string | undefined {
  let found: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?NAUTILO_PERSONAL_PROVIDER_CUSTODY\s*=(.*)$/);
    if (!match) continue;
    if (found !== undefined) throw new PersonalProviderCustodyError("custody_invalid");
    let value = match[1]!.trim();
    if (value.startsWith("'")) {
      if (!value.endsWith("'")) throw new PersonalProviderCustodyError("custody_invalid");
      value = value.slice(1, -1);
    } else if (value.startsWith('"')) {
      try { value = JSON.parse(value) as string; } catch { throw new PersonalProviderCustodyError("custody_invalid"); }
    }
    found = value;
  }
  return found;
}
