import { concatV2, decodeExact, encodeU32, frameText } from "../format/v2-primitives.ts";
import { assertPortableId } from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";

export interface MemoryEmbeddingDisclosureV2 {
  readonly contractVersion: 2;
  readonly canonicalSpace: Readonly<{
    provider: "openai" | "openrouter" | "venice";
    model: string;
    dimensions: 1536;
  }>;
  readonly processingRoute:
    | Readonly<{ transport: "direct" }>
    | Readonly<{
      transport: "surplus_marketplace";
      marketplacePolicyVersion: "surplus-embedding-marketplace-v1";
      dataRecipientClasses: readonly ["surplus", "marketplace_seller", "seller_upstream_processor"];
    }>;
}

const RECIPIENTS = Object.freeze([
  "surplus", "marketplace_seller", "seller_upstream_processor",
] as const);
const POLICY = "surplus-embedding-marketplace-v1";
// One bounded canonical structure: version, provider/model/dimensions, route,
// and (for marketplace execution) the fixed policy and three recipient classes.
export const MAX_MEMORY_EMBEDDING_DISCLOSURE_WIRE_BYTES_V2 =
  7 * (4 + V2_LIMITS.idBytes) + 8;

function exactObject<Field extends string>(value: unknown, fields: readonly Field[]): asserts value is Record<Field, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Reflect.ownKeys(value).length !== fields.length
    || !fields.every((field) => Object.hasOwn(value, field))) {
    throw new TypeError("Memory embedding disclosure has an invalid field set");
  }
}

export function assertMemoryEmbeddingDisclosureV2(value: unknown): asserts value is MemoryEmbeddingDisclosureV2 {
  exactObject(value, ["contractVersion", "canonicalSpace", "processingRoute"]);
  if (value.contractVersion !== 2) throw new TypeError("Memory embedding disclosure version is invalid");
  const space = value.canonicalSpace;
  exactObject(space, ["provider", "model", "dimensions"]);
  if ((space.provider !== "openai" && space.provider !== "openrouter" && space.provider !== "venice")
    || space.dimensions !== 1536) throw new TypeError("Memory embedding canonical space is invalid");
  assertPortableId("Memory embedding canonical model", space.model);
  const route = value.processingRoute;
  if (typeof route !== "object" || route === null) throw new TypeError("Memory embedding route is invalid");
  if ((route as Record<string, unknown>)["transport"] === "direct") {
    exactObject(route, ["transport"]);
    return;
  }
  exactObject(route, ["transport", "marketplacePolicyVersion", "dataRecipientClasses"]);
  const recipients = route.dataRecipientClasses;
  if (route.transport !== "surplus_marketplace" || route.marketplacePolicyVersion !== POLICY
    || !Array.isArray(recipients)
    || recipients.length !== RECIPIENTS.length
    || Reflect.ownKeys(recipients).length !== RECIPIENTS.length + 1
    || !RECIPIENTS.every((recipient, index) => recipients[index] === recipient)
    || space.provider !== "venice" || space.model !== "text-embedding-3-large") {
    throw new TypeError("Memory embedding marketplace disclosure is invalid");
  }
}

export function encodeMemoryEmbeddingDisclosureV2(value: MemoryEmbeddingDisclosureV2): Uint8Array {
  assertMemoryEmbeddingDisclosureV2(value);
  return concatV2(
    encodeU32(value.contractVersion),
    frameText(value.canonicalSpace.provider),
    frameText(value.canonicalSpace.model),
    encodeU32(value.canonicalSpace.dimensions),
    frameText(value.processingRoute.transport),
    ...(value.processingRoute.transport === "direct" ? [] : [
      frameText(value.processingRoute.marketplacePolicyVersion),
      ...value.processingRoute.dataRecipientClasses.map(frameText),
    ]),
  );
}

export function decodeMemoryEmbeddingDisclosureV2(bytes: Uint8Array): MemoryEmbeddingDisclosureV2 {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_MEMORY_EMBEDDING_DISCLOSURE_WIRE_BYTES_V2) {
    throw new TypeError("Memory embedding disclosure wire is invalid");
  }
  const value = decodeExact(bytes, (reader) => {
    const contractVersion = reader.readVersion(2);
    const canonicalSpace = {
      provider: reader.readText(V2_LIMITS.idBytes),
      model: reader.readText(V2_LIMITS.idBytes),
      dimensions: reader.readU32(),
    };
    const transport = reader.readText(V2_LIMITS.idBytes);
    return { contractVersion, canonicalSpace, processingRoute: transport === "direct"
      ? { transport }
      : { transport, marketplacePolicyVersion: reader.readText(V2_LIMITS.idBytes),
        dataRecipientClasses: RECIPIENTS.map(() => reader.readText(V2_LIMITS.idBytes)) } };
  });
  assertMemoryEmbeddingDisclosureV2(value);
  const canonical = encodeMemoryEmbeddingDisclosureV2(value);
  if (canonical.length !== bytes.length || canonical.some((byte, index) => byte !== bytes[index])) {
    throw new TypeError("Memory embedding disclosure wire is noncanonical");
  }
  if (value.processingRoute.transport === "surplus_marketplace") Object.freeze(value.processingRoute.dataRecipientClasses);
  Object.freeze(value.canonicalSpace);
  Object.freeze(value.processingRoute);
  return Object.freeze(value);
}

export function sameMemoryEmbeddingDisclosureV2(left: MemoryEmbeddingDisclosureV2, right: MemoryEmbeddingDisclosureV2): boolean {
  const leftBytes = encodeMemoryEmbeddingDisclosureV2(left);
  const rightBytes = encodeMemoryEmbeddingDisclosureV2(right);
  return leftBytes.length === rightBytes.length && leftBytes.every((byte, index) => byte === rightBytes[index]);
}
