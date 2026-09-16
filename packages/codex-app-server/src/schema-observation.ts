import { createHash } from "node:crypto";
import {
  CERTIFIED_SCHEMA_FINGERPRINT,
  CONSUMED_FIELD_REQUIREMENTS,
  DEFAULT_SCHEMA_PROBE_LIMITS,
  createVerifiedProtocolObservation,
  type JsonShapeKind,
  type ProtocolObservation,
  type VerifiedExecutableEvidence,
  type VerifiedProtocolObservation,
} from "./compatibility-contract";
import { assertReviewedJson, type ReviewedJson } from "./validators";

export interface PortableSchemaFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

export type SchemaObservation = VerifiedProtocolObservation;

export interface SchemaObservationLimits {
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly maxFileBytes: number;
  readonly maxJsonDepth: number;
  readonly maxJsonNodes: number;
}

const ALL_KINDS: readonly JsonShapeKind[] = [
  "array", "boolean", "null", "number", "object", "string",
];
const FIELD_TARGETS = CONSUMED_FIELD_REQUIREMENTS.map(({ path }) => {
  const separator = path.indexOf(".");
  return [path.slice(0, separator), path.slice(separator + 1)] as const;
});
const REQUIREDNESS_EXCEPTIONS = new Map<
string,
"serde_default" | "nullable_ts" | "wire_observed_optional"
>([
  ["InitializeCapabilities.experimentalApi", "serde_default"],
  ["ToolRequestUserInputQuestion.isOther", "serde_default"],
  ["ToolRequestUserInputQuestion.isSecret", "serde_default"],
  ["ToolRequestUserInputQuestion.options", "nullable_ts"],
  ["TurnSteerResponse.turnId", "wire_observed_optional"],
  ["CommandExecutionRequestApprovalParams.startedAtMs", "wire_observed_optional"],
  ["FileChangeRequestApprovalParams.startedAtMs", "wire_observed_optional"],
  ["PermissionsRequestApprovalParams.startedAtMs", "wire_observed_optional"],
  ["ChatgptDeviceCodev2::LoginAccountResponse.loginId", "wire_observed_optional"],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateRelativePath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    relativePath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) throw new TypeError("schema path is not portable");
}

function schemaDocumentOrder(
  [leftPath]: readonly [string, Record<string, unknown>],
  [rightPath]: readonly [string, Record<string, unknown>],
): number {
  const isV2 = (path: string) => path.startsWith("v2/");
  const versionOrder = Number(isV2(rightPath)) - Number(isV2(leftPath));
  return versionOrder || leftPath.localeCompare(rightPath);
}

function canonicalJson(value: ReviewedJson): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as { readonly [key: string]: ReviewedJson };
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`).join(",")}}`;
}

type LexFrame =
  | { kind: "object"; state: "key" | "colon" | "value" | "after" }
  | { kind: "array"; state: "value" | "after" };

function lexicalJsonPreflight(
  bytes: Uint8Array,
  maxDepth: number,
  maxNodes: number,
): number {
  const stack: LexFrame[] = [];
  let rootState: "value" | "after" = "value";
  let nodes = 0;
  const expectsValue = () => {
    const parent = stack.at(-1);
    return parent ? parent.state === "value" : rootState === "value";
  };
  const startValue = () => {
    if (!expectsValue()) return;
    if (stack.length > maxDepth) {
      throw new RangeError("schema JSON exceeds depth limit");
    }
    nodes += 1;
    if (nodes > maxNodes) throw new RangeError("schema set has too many JSON nodes");
    const parent = stack.at(-1);
    if (parent) parent.state = "after";
    else rootState = "after";
  };
  const whitespace = (byte: number) =>
    byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;

  for (let index = 0; index < bytes.byteLength; index += 1) {
    const byte = bytes[index]!;
    if (whitespace(byte)) continue;
    const parent = stack.at(-1);
    if (byte === 0x22) {
      let closed = false;
      for (index += 1; index < bytes.byteLength; index += 1) {
        if (bytes[index] === 0x5c) {
          index += 1;
        } else if (bytes[index] === 0x22) {
          closed = true;
          break;
        }
      }
      if (!closed) throw new TypeError("malformed schema JSON");
      if (parent?.kind === "object" && parent.state === "key") parent.state = "colon";
      else startValue();
      continue;
    }
    if (byte === 0x7b || byte === 0x5b) {
      if (!expectsValue()) continue;
      startValue();
      stack.push(byte === 0x7b
        ? { kind: "object", state: "key" }
        : { kind: "array", state: "value" });
      continue;
    }
    if (byte === 0x7d || byte === 0x5d) {
      stack.pop();
      continue;
    }
    if (byte === 0x3a) {
      if (parent?.kind === "object" && parent.state === "colon") parent.state = "value";
      continue;
    }
    if (byte === 0x2c) {
      if (parent?.kind === "object") parent.state = "key";
      else if (parent?.kind === "array") parent.state = "value";
      continue;
    }
    if (expectsValue()) {
      startValue();
      while (
        index + 1 < bytes.byteLength &&
        !whitespace(bytes[index + 1]!) &&
        ![0x2c, 0x5d, 0x7d].includes(bytes[index + 1]!)
      ) index += 1;
    }
  }
  return nodes;
}

function methodMembers(schema: Record<string, unknown>): string[] {
  const variants = Array.isArray(schema["oneOf"]) ? schema["oneOf"] : [];
  const members = new Set<string>();
  for (const variant of variants) {
    if (!isRecord(variant) || !isRecord(variant["properties"])) continue;
    const method = variant["properties"]["method"];
    if (!isRecord(method) || !Array.isArray(method["enum"])) continue;
    for (const member of method["enum"]) if (typeof member === "string") members.add(member);
  }
  return [...members].sort();
}

function threadItemMembers(schema: Record<string, unknown>): string[] {
  const variants = Array.isArray(schema["oneOf"]) ? schema["oneOf"] : [];
  const members = new Set<string>();
  for (const variant of variants) {
    if (!isRecord(variant) || !isRecord(variant["properties"])) continue;
    const type = variant["properties"]["type"];
    if (!isRecord(type) || !Array.isArray(type["enum"])) continue;
    for (const member of type["enum"]) if (typeof member === "string") members.add(member);
  }
  return [...members].sort();
}

function referencedName(reference: unknown): string | undefined {
  if (typeof reference !== "string") return undefined;
  const match = /#\/definitions\/([^/]+)$/.exec(reference);
  return match?.[1];
}

function shapeKinds(
  schema: unknown,
  definitions: ReadonlyMap<string, Record<string, unknown>>,
  seen = new Set<string>(),
): JsonShapeKind[] {
  if (schema === true) return [...ALL_KINDS];
  if (schema === false) return [];
  if (!isRecord(schema)) return [];
  const reference = referencedName(schema["$ref"]);
  if (reference) {
    if (reference === "AbsolutePathBuf") return ["string"];
    if (
      reference === "AdditionalNetworkPermissions" ||
      reference === "AdditionalFileSystemPermissions"
    ) return ["object"];
    if (seen.has(reference)) return [...ALL_KINDS];
    const target = definitions.get(reference);
    if (!target) return [];
    const next = new Set(seen);
    next.add(reference);
    return shapeKinds(target, definitions, next);
  }
  const kinds = new Set<JsonShapeKind>();
  const type = schema["type"];
  const addType = (candidate: unknown) => {
    if (candidate === "integer") {
      kinds.add("number");
      return;
    }
    if (ALL_KINDS.includes(candidate as JsonShapeKind)) kinds.add(candidate as JsonShapeKind);
  };
  if (Array.isArray(type)) type.forEach(addType);
  else addType(type);
  for (const keyword of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(schema[keyword])) {
      for (const branch of schema[keyword]) {
        const branchReference =
          isRecord(branch) ? referencedName(branch["$ref"]) : undefined;
        if (
          branchReference === "AdditionalNetworkPermissions" ||
          branchReference === "AdditionalFileSystemPermissions"
        ) {
          kinds.add("object");
        }
        for (const kind of shapeKinds(branch, definitions, seen)) kinds.add(kind);
      }
    }
  }
  if (Object.keys(schema).length === 0) return [...ALL_KINDS];
  const enumValues: unknown[] =
    Array.isArray(schema["enum"]) ? schema["enum"] as unknown[] : [];
  const literalValues: unknown[] = [
    ...enumValues,
    ...(Object.hasOwn(schema, "const") ? [schema["const"]] : []),
  ];
  for (const literal of literalValues) {
    if (literal === null) kinds.add("null");
    else if (typeof literal === "string") kinds.add("string");
    else if (typeof literal === "number") kinds.add("number");
    else if (typeof literal === "boolean") kinds.add("boolean");
  }
  return ALL_KINDS.filter((kind) => kinds.has(kind));
}

function shapeLiterals(
  schema: unknown,
  definitions: ReadonlyMap<string, Record<string, unknown>>,
  seen = new Set<string>(),
): Array<string | number | boolean | null> {
  if (!isRecord(schema)) return [];
  const reference = referencedName(schema["$ref"]);
  if (reference) {
    if (seen.has(reference)) return [];
    const target = definitions.get(reference);
    if (!target) return [];
    const next = new Set(seen);
    next.add(reference);
    return shapeLiterals(target, definitions, next);
  }
  const literals = new Set<string | number | boolean | null>();
  if (Array.isArray(schema["enum"])) {
    for (const value of schema["enum"] as unknown[]) {
      if (
        value === null || typeof value === "string" ||
        typeof value === "number" || typeof value === "boolean"
      ) literals.add(value);
    }
  }
  if (
    Object.hasOwn(schema, "const") &&
    (schema["const"] === null ||
      ["string", "number", "boolean"].includes(typeof schema["const"]))
  ) {
    literals.add(schema["const"] as string | number | boolean | null);
  }
  for (const keyword of ["oneOf", "anyOf", "allOf"] as const) {
    if (!Array.isArray(schema[keyword])) continue;
    for (const branch of schema[keyword]) {
      for (const literal of shapeLiterals(branch, definitions, seen)) literals.add(literal);
    }
  }
  if (isRecord(schema["items"])) {
    for (const literal of shapeLiterals(schema["items"], definitions, seen)) {
      literals.add(literal);
    }
  }
  return [...literals].sort((left, right) => String(left).localeCompare(String(right)));
}

export function observeProtocolSchemas(
  files: readonly PortableSchemaFile[],
  limits: SchemaObservationLimits = DEFAULT_SCHEMA_PROBE_LIMITS,
  executable: VerifiedExecutableEvidence | null = null,
): SchemaObservation {
  if (files.length > limits.maxFiles) throw new RangeError("too many schema files");
  const documents = new Map<string, Record<string, unknown>>();
  let totalBytes = 0;
  let totalNodes = 0;
  for (const file of files) {
    validateRelativePath(file.relativePath);
    if (documents.has(file.relativePath)) throw new TypeError("duplicate schema path");
    if (file.bytes.byteLength > limits.maxFileBytes) throw new RangeError("schema file too large");
    totalBytes += file.bytes.byteLength;
    if (totalBytes > limits.maxTotalBytes) throw new RangeError("schema set too large");
    const lexicalNodes = lexicalJsonPreflight(
      file.bytes,
      limits.maxJsonDepth,
      limits.maxJsonNodes - totalNodes,
    );
    totalNodes += lexicalNodes;
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
    } catch {
      throw new TypeError("malformed schema JSON");
    }
    assertReviewedJson(parsed, {
      maxDepth: limits.maxJsonDepth,
      maxNodes: limits.maxJsonNodes,
    });
    if (!isRecord(parsed)) throw new TypeError("schema document must be an object");
    documents.set(file.relativePath, parsed);
  }

  const definitions = new Map<string, Record<string, unknown>>();
  const titled = new Map<string, Record<string, unknown>>();
  const definitionScopes =
    new WeakMap<Record<string, unknown>, ReadonlyMap<string, Record<string, unknown>>>();
  // Codex emits legacy root schemas alongside the current v2 per-type
  // projection. Filesystem enumeration order is unspecified, so make v2
  // authority explicit before collecting first-wins titled union variants.
  for (const [, document] of [...documents].sort(schemaDocumentOrder)) {
    const localDefinitions = new Map<string, Record<string, unknown>>();
    if (isRecord(document["definitions"])) {
      for (const [name, definition] of Object.entries(document["definitions"])) {
        if (isRecord(definition)) localDefinitions.set(name, definition);
      }
    }
    const work: unknown[] = [document];
    const seen = new Set<object>();
    while (work.length > 0) {
      const candidate = work.pop();
      if (!isRecord(candidate) || seen.has(candidate)) continue;
      seen.add(candidate);
      definitionScopes.set(candidate, localDefinitions);
      if (
        typeof candidate["title"] === "string" &&
        !titled.has(candidate["title"])
      ) {
        titled.set(candidate["title"], candidate);
      }
      const children = Object.entries(candidate)
        .sort(([left], [right]) => right.localeCompare(left))
        .map(([, child]) => child);
      for (const child of children) {
        if (isRecord(child)) work.push(child);
        else if (Array.isArray(child)) {
          for (let index = child.length - 1; index >= 0; index -= 1) {
            work.push(child[index]);
          }
        }
      }
    }
    if (typeof document["title"] === "string") {
      titled.set(document["title"], document);
    }
    if (isRecord(document["definitions"])) {
      for (const [name, definition] of Object.entries(document["definitions"])) {
        if (isRecord(definition)) definitions.set(name, definition);
      }
    }
  }
  for (const [name, schema] of titled) definitions.set(name, schema);

  const find = (name: string) => definitions.get(name) ?? titled.get(name);
  const members: Record<string, string[]> = {};
  const client = find("ClientRequest");
  const requests = find("ServerRequest");
  const notifications = find("ServerNotification");
  const items = find("ThreadItem");
  if (client) members["client_request"] = methodMembers(client);
  if (requests) members["server_request"] = methodMembers(requests);
  if (notifications) members["server_notification"] = methodMembers(notifications);
  if (items) members["thread_item"] = threadItemMembers(items);
  members["response"] = [...definitions.keys()]
    .filter((name) => name.endsWith("Response"))
    .sort();

  const hash = createHash("sha256");
  for (const [relativePath, document] of [...documents].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(canonicalJson(document as ReviewedJson));
    hash.update("\0");
  }
  const schemaFingerprint = `sha256:${hash.digest("hex")}`;

  const fields: ProtocolObservation["fields"] = {};
  for (const [typeName, fieldName] of FIELD_TARGETS) {
    const schema = find(typeName);
    if (!schema || !isRecord(schema["properties"])) continue;
    const field = schema["properties"][fieldName];
    if (!isRecord(field) && typeof field !== "boolean") continue;
    const path = `${typeName}.${fieldName}`;
    const schemaRequired =
      Array.isArray(schema["required"]) && schema["required"].includes(fieldName);
    const exception =
      schemaFingerprint === CERTIFIED_SCHEMA_FINGERPRINT
        ? REQUIREDNESS_EXCEPTIONS.get(path)
        : undefined;
    const exceptionRequired =
      exception === "serde_default"
        ? isRecord(field) && Object.hasOwn(field, "default")
        : exception === "nullable_ts";
    const scope = definitionScopes.get(schema) ?? definitions;
    const literals = shapeLiterals(field, scope);
    const kinds = shapeKinds(field, scope);
    if (
      (path === "GrantedPermissionProfile.network" ||
        path === "GrantedPermissionProfile.fileSystem") &&
      !kinds.includes("object")
    ) {
      kinds.push("object");
      kinds.sort();
    }
    fields[path] = {
      required:
        exception === "wire_observed_optional"
          ? false
          : schemaRequired || exceptionRequired,
      kinds,
      ...(literals.length > 0 ? { literals } : {}),
    };
  }

  return createVerifiedProtocolObservation(
    schemaFingerprint,
    executable,
    { members, fields },
  );
}
