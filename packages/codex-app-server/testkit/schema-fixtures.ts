import experimentalInventoryJson from "../generated/0.146.0/inventory/experimental.json";
import {
  CONSUMED_FIELD_REQUIREMENTS,
  type JsonShapeKind,
} from "../src/compatibility-contract";
import type {
  ProtocolInventoryEntry,
  ProtocolSurface,
} from "../src/protocol-inventory";
import type { PortableSchemaFile } from "../src/schema-observation";

const encoder = new TextEncoder();
const inventory = experimentalInventoryJson as {
  readonly entries: readonly ProtocolInventoryEntry[];
};

interface FixtureDefinition {
  title: string;
  type?: "object";
  required?: string[];
  properties?: Record<string, Record<string, unknown>>;
  oneOf?: Array<Record<string, unknown>>;
}

function discriminatorUnion(
  title: string,
  discriminator: "method" | "type",
  values: readonly string[],
): FixtureDefinition {
  return {
    title,
    oneOf: values.map((value) => ({
      type: "object",
      properties: {
        [discriminator]: { enum: [value] },
      },
    })),
  };
}

function fieldSchema(
  kinds: readonly JsonShapeKind[],
  literals?: readonly (string | number | boolean | null)[],
): Record<string, unknown> {
  if (kinds.length === 6 && (!literals || literals.length === 0)) return {};
  const type = kinds.length === 1 ? kinds[0] : kinds;
  if (!literals || literals.length === 0) return { type };
  return kinds.includes("array")
    ? { type, items: { enum: literals } }
    : { type, enum: literals };
}

function inventoryMembers(surface: ProtocolSurface): readonly string[] {
  return inventory.entries
    .filter((entry) => entry.surface === surface)
    .map((entry) => entry.name);
}

/**
 * Compact synthetic schema projection for runtime-manager and compatibility
 * mechanics tests. The official full schema corpus is regenerated only by
 * protocol:check; ordinary tests consume this reviewed bounded projection.
 */
export function createAnchorSchemaFixtureFiles(): readonly PortableSchemaFile[] {
  const definitions: Record<string, FixtureDefinition> = {};

  for (const field of CONSUMED_FIELD_REQUIREMENTS) {
    const { path } = field;
    const separator = path.indexOf(".");
    const typeName = path.slice(0, separator);
    const fieldName = path.slice(separator + 1);
    const definition = definitions[typeName] ?? {
      title: typeName,
      type: "object",
      required: [],
      properties: {},
    };
    definition.properties![fieldName] = fieldSchema(
      field.kinds,
      field.literals,
    );
    if (field.required) definition.required!.push(fieldName);
    definitions[typeName] = definition;
  }

  definitions["ClientRequest"] = discriminatorUnion(
    "ClientRequest",
    "method",
    inventoryMembers("client_request"),
  );
  definitions["ServerRequest"] = discriminatorUnion(
    "ServerRequest",
    "method",
    inventoryMembers("server_request"),
  );
  definitions["ServerNotification"] = discriminatorUnion(
    "ServerNotification",
    "method",
    inventoryMembers("server_notification"),
  );
  definitions["ThreadItem"] = discriminatorUnion(
    "ThreadItem",
    "type",
    inventoryMembers("thread_item"),
  );
  for (const response of inventoryMembers("response")) {
    definitions[response] ??= {
      title: response,
      type: "object",
      required: [],
      properties: {},
    };
  }

  return Object.freeze([
    Object.freeze({
      relativePath: "nautilo-synthetic-anchor-projection.json",
      bytes: encoder.encode(JSON.stringify({
        title: "NautiloSyntheticAnchorProjection",
        definitions,
      })),
    }),
  ]);
}
