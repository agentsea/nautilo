import { computeComputerUseJsonSchemaDigest } from "@nautilo/computer-use-contracts/schema-digest";
import { z } from "zod";

const VERSION = /^(\d{4})-(\d{2})-(\d{2})\.(\d{1,6})$/u;
const CONTRACT_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/u;
const SCHEMA_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+\.(?:input|result)$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const SIGNING_KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const PLACEHOLDER_SCHEMA_DIGEST = `sha256:${"0".repeat(64)}`;

const schemaDigestSchema = z.string().regex(SHA256).refine(
  (value) => value !== PLACEHOLDER_SCHEMA_DIGEST,
  "placeholder schema digest rejected",
);

export const computerUseContractDescriptorSchema = z.object({
  contractNamespace: z.string().regex(CONTRACT_ID),
  contractId: z.string().regex(CONTRACT_ID),
  contractVersion: z.number().int().positive(),
  schemaDigest: schemaDigestSchema,
  effectClass: z.enum(["read", "mutate", "sensitive"]),
  replayClass: z.enum(["safe", "at_most_once"]),
  authorityClass: z.literal("standing_computer_use"),
  attachmentClass: z.enum(["none", "png"]),
  disclosureClass: z.enum(["none", "semantic", "visual", "semantic_and_visual"]),
}).strict();

const jsonSchemaDocumentSchema = z.record(z.string(), z.json());

const publicSchemaMetadataSchema = z.object({
  schemaId: z.string().regex(SCHEMA_ID),
  schemaVersion: z.number().int().positive(),
  jsonSchema: jsonSchemaDocumentSchema,
}).strict();

const classificationProvenanceSchema = z.object({
  reviewedSchemaDigest: schemaDigestSchema,
  effectClass: z.literal("server_reviewed"),
  replayClass: z.literal("server_reviewed"),
  authorityClass: z.literal("server_reviewed"),
  attachmentClass: z.literal("server_reviewed"),
  disclosureClass: z.literal("server_reviewed"),
}).strict();

const projectionMetadataSchema = z.object({
  toolName: z.string().regex(/^computer_[a-z0-9_]{2,61}$/u),
  modelDescription: z.string().trim().min(1),
  label: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  argumentsSummary: z.string().trim().min(1),
  resultSummary: z.string().trim().min(1),
}).strict();

const executionLaneSchema = z.enum(["host", "legacy_native"]);


export function computeComputerUseContractSchemaDigestV1(
  publicSchemas: Readonly<{
    input: Readonly<{ jsonSchema: Readonly<Record<string, unknown>> }>;
    result: Readonly<{ jsonSchema: Readonly<Record<string, unknown>> }>;
  }>,
): string {
  return computeComputerUseJsonSchemaDigest(
    publicSchemas.input.jsonSchema,
    publicSchemas.result.jsonSchema,
  );
}

export const computerUseContractCatalogueEntrySchema = z.object({
  descriptor: computerUseContractDescriptorSchema,
  executionLane: executionLaneSchema,
  publicSchemas: z.object({
    input: publicSchemaMetadataSchema,
    result: publicSchemaMetadataSchema,
  }).strict(),
  projection: projectionMetadataSchema,
  classificationProvenance: classificationProvenanceSchema,
  /** Exact released baseline for Desktop versions predating Host advertisement. */
  legacyDefault: z.literal(true).optional(),
  /** Release-reviewed only for descriptor versions whose Host coordinates resources. */
  scheduling: z.object({ readConcurrency: z.literal("host_coordinated") }).strict().optional(),
}).strict().superRefine((entry, context) => {
  if (entry.scheduling !== undefined && (entry.executionLane !== "host"
    || entry.descriptor.effectClass !== "read" || entry.descriptor.replayClass !== "safe")) {
    context.addIssue({ code: "custom", message: "coordinated reads require a Host read/safe contract" });
  }
  const computedSchemaDigest = computeComputerUseContractSchemaDigestV1(entry.publicSchemas);
  if (computedSchemaDigest !== entry.descriptor.schemaDigest) {
    context.addIssue({ code: "custom", message: "descriptor must bind the canonical public schemas" });
  }
  if (entry.classificationProvenance.reviewedSchemaDigest !== entry.descriptor.schemaDigest) {
    context.addIssue({ code: "custom", message: "classification provenance must bind the reviewed schema digest" });
  }
  const prefix = `${entry.descriptor.contractNamespace}.${entry.descriptor.contractId}.`;
  if (entry.publicSchemas.input.schemaId !== `${prefix}input`
    || entry.publicSchemas.result.schemaId !== `${prefix}result`
    || entry.publicSchemas.input.schemaVersion !== entry.descriptor.contractVersion
    || entry.publicSchemas.result.schemaVersion !== entry.descriptor.contractVersion) {
    context.addIssue({ code: "custom", message: "public schema metadata must bind the exact descriptor identity" });
  }
});

const baseCatalogueSchema = z.object({
  formatVersion: z.literal(1),
  catalogueVersion: z.string().regex(VERSION),
  publishedAt: z.string().datetime({ offset: false }),
  /** Signed, model-facing family guidance; optional for older v1 artifacts. */
  modelGuidance: z.string().trim().min(1).optional(),
  contracts: z.array(computerUseContractCatalogueEntrySchema).min(1),
}).strict().superRefine((catalogue, context) => {
  const keys = catalogue.contracts.map((entry) => {
    const descriptor = entry.descriptor;
    return `${descriptor.contractNamespace}\u0000${descriptor.contractId}\u0000${descriptor.contractVersion}`;
  });
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", message: "catalogue contract descriptor identities must be unique" });
  }
  const families = new Map<string, typeof catalogue.contracts>();
  for (const entry of catalogue.contracts) {
    const family = families.get(entry.projection.toolName) ?? [];
    const prior = family[0]?.descriptor;
    if (prior && (prior.contractNamespace !== entry.descriptor.contractNamespace
      || prior.contractId !== entry.descriptor.contractId
      || prior.effectClass !== entry.descriptor.effectClass
      || prior.replayClass !== entry.descriptor.replayClass
      || prior.authorityClass !== entry.descriptor.authorityClass)) {
      context.addIssue({ code: "custom", message: "tool versions must preserve contract family and authority classification" });
    }
    family.push(entry);
    families.set(entry.projection.toolName, family);
  }
  for (const family of families.values()) {
    if (family.filter((entry) => entry.legacyDefault).length > 1) {
      context.addIssue({ code: "custom", message: "tool family has multiple legacy defaults" });
    }
  }
  const sorted = [...keys].sort();
  if (keys.some((key, index) => key !== sorted[index])) {
    context.addIssue({ code: "custom", message: "catalogue contracts must use canonical descriptor order" });
  }
});

export const computerUseContractCatalogueSnapshotV1Schema = baseCatalogueSchema;
export const computerUseContractCatalogueV1Schema = baseCatalogueSchema.extend({
  provenance: z.enum(["bundled", "remote"]),
}).strict();

export const computerUseContractCatalogueReleasePointerV1Schema = z.object({
  catalogueVersion: z.string().regex(VERSION),
  artifactSha256: z.string().regex(HEX_SHA256),
  signingKeyId: z.string().regex(SIGNING_KEY_ID),
  signature: z.string().base64().refine(
    (value) => /^[A-Za-z0-9+/]{86}==$/u.test(value),
    "signature must decode to 64 bytes",
  ),
}).strict();

export type ComputerUseContractDescriptor = z.infer<typeof computerUseContractDescriptorSchema>;
export type ComputerUseContractCatalogueEntry = z.infer<typeof computerUseContractCatalogueEntrySchema>;
export type ComputerUseContractCatalogueV1 = z.infer<typeof computerUseContractCatalogueV1Schema>;

export function canonicalComputerUseContractCatalogueSigningPayloadV1(
  catalogueVersion: string,
  artifactSha256: string,
): string {
  return `nautilo-computer-use-contract-catalogue-v1\ncatalogueVersion=${catalogueVersion}\nartifactSha256=${artifactSha256}\n`;
}

export function immutableComputerUseContractCatalogueFilenameV1(
  catalogueVersion: string,
  artifactSha256: string,
): string {
  if (!VERSION.test(catalogueVersion) || !HEX_SHA256.test(artifactSha256)) {
    throw new Error("computer use contract catalogue immutable identity rejected");
  }
  return `computer-use-contract-catalogue-v1.${catalogueVersion}.${artifactSha256}.json`;
}

export function compareComputerUseContractCatalogueVersionV1(left: string, right: string): number {
  const parse = (value: string): readonly [number, number, number, number] | null => {
    const match = VERSION.exec(value);
    if (!match) return null;
    const tuple = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])] as const;
    const timestamp = Date.UTC(tuple[0], tuple[1] - 1, tuple[2]);
    const date = new Date(timestamp);
    if (date.getUTCFullYear() !== tuple[0] || date.getUTCMonth() !== tuple[1] - 1 || date.getUTCDate() !== tuple[2]) return null;
    return tuple;
  };
  const lhs = parse(left), rhs = parse(right);
  if (!lhs || !rhs) throw new Error("computer use contract catalogue version rejected");
  for (let index = 0; index < lhs.length; index += 1) {
    if (lhs[index] !== rhs[index]) return lhs[index]! < rhs[index]! ? -1 : 1;
  }
  return 0;
}
