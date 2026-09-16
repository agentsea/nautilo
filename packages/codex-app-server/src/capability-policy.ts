import experimentalInventoryJson from "../generated/0.146.0/inventory/experimental.json";
import stableInventoryJson from "../generated/0.146.0/inventory/stable.json";
import policyJson from "./capability-policy.0.146.0.json";
import type {
  ObservedFieldShape,
  ProtocolObservation,
} from "./compatibility-contract";
import type { ProtocolInventoryEntry, ProtocolSurface } from "./protocol-inventory";

/** Product treatment is independent from upstream stability. */
export type ProtocolProductState =
  | "enabled"
  | "diagnostic"
  | "hidden"
  | "forbidden";

export type ProtocolMaturity = "stable" | "experimental";

export interface ProtocolCapabilityPolicyEntry extends ProtocolInventoryEntry {
  readonly maturity: ProtocolMaturity;
  readonly state: ProtocolProductState;
}

export interface ProtocolCapabilityPolicy {
  readonly schemaVersion: 1;
  readonly anchorId: string;
  readonly entries: readonly ProtocolCapabilityPolicyEntry[];
}

export interface ProtocolCapabilityPolicySource {
  readonly schemaVersion: number;
  readonly anchorId: string;
  readonly entries: Readonly<Record<ProtocolSurface, Readonly<Record<string, unknown>>>>;
}

const SURFACES: readonly ProtocolSurface[] = [
  "client_request",
  "response",
  "client_notification",
  "server_request",
  "server_notification",
  "thread_item",
];

const PRODUCT_STATES = new Set<ProtocolProductState>([
  "enabled",
  "diagnostic",
  "hidden",
  "forbidden",
]);

const policySource = policyJson as ProtocolCapabilityPolicySource;
const experimentalInventory = experimentalInventoryJson as {
  readonly entries: readonly ProtocolInventoryEntry[];
};
const stableInventory = stableInventoryJson as {
  readonly entries: readonly ProtocolInventoryEntry[];
};

function memberKey(entry: Pick<ProtocolInventoryEntry, "surface" | "name">): string {
  return `${entry.surface}:${entry.name}`;
}

function asProductState(value: unknown, key: string): ProtocolProductState {
  if (typeof value !== "string" || !PRODUCT_STATES.has(value as ProtocolProductState)) {
    throw new Error(`Invalid product policy state for ${key}`);
  }
  return value as ProtocolProductState;
}

/**
 * Reject drift instead of defaulting a newly generated surface to hidden.
 * A reviewer must classify both additions and removals deliberately.
 */
export function validateProtocolCapabilityPolicy(
  source: ProtocolCapabilityPolicySource = policySource,
): ProtocolCapabilityPolicy {
  if (source.schemaVersion !== 1) {
    throw new Error(`Unsupported capability policy schema: ${source.schemaVersion}`);
  }

  for (const surface of Object.keys(source.entries)) {
    if (!(SURFACES as readonly string[]).includes(surface)) {
      throw new Error(`Capability policy contains unknown surface: ${surface}`);
    }
  }

  const expectedKeys = new Set(experimentalInventory.entries.map(memberKey));
  const supplied: Array<Pick<ProtocolInventoryEntry, "surface" | "name"> & { state: ProtocolProductState }> = [];

  for (const surface of SURFACES) {
    const surfacePolicy = source.entries[surface];
    if (!surfacePolicy) {
      throw new Error(`Capability policy is missing surface: ${surface}`);
    }
    for (const [name, value] of Object.entries(surfacePolicy)) {
      const key = `${surface}:${name}`;
      if (!expectedKeys.delete(key)) {
        throw new Error(`Capability policy contains unknown or duplicate member: ${key}`);
      }
      supplied.push({ surface, name, state: asProductState(value, key) });
    }
  }

  if (expectedKeys.size > 0) {
    throw new Error(
      `Capability policy has unclassified generated members: ${[...expectedKeys].sort().join(", ")}`,
    );
  }

  const stableKeys = new Set(stableInventory.entries.map(memberKey));
  const generatedByKey = new Map(experimentalInventory.entries.map((entry) => [memberKey(entry), entry]));
  const entries = supplied
    .map((entry) => {
      const generated = generatedByKey.get(memberKey(entry));
      if (!generated) throw new Error(`Generated protocol member disappeared: ${memberKey(entry)}`);
      return Object.freeze({
        ...generated,
        maturity: stableKeys.has(memberKey(entry)) ? "stable" : "experimental",
        state: entry.state,
      });
    })
    .sort(
      (left, right) =>
        left.surface.localeCompare(right.surface) ||
        left.name.localeCompare(right.name),
    );

  return Object.freeze({
    schemaVersion: 1,
    anchorId: source.anchorId,
    entries: Object.freeze(entries),
  });
}

/** The reviewed policy is evaluated eagerly so drift fails at process start and in CI. */
export const PROTOCOL_CAPABILITY_POLICY = validateProtocolCapabilityPolicy();

export function getProtocolCapabilityPolicyEntry(
  surface: ProtocolSurface,
  name: string,
): ProtocolCapabilityPolicyEntry | undefined {
  return PROTOCOL_CAPABILITY_POLICY.entries.find(
    (entry) => entry.surface === surface && entry.name === name,
  );
}

export type CapabilityFeature =
  | "experimental_api"
  | "request_user_input";

export interface CapabilityFeaturePolicy {
  readonly members: readonly Pick<ProtocolInventoryEntry, "surface" | "name">[];
  readonly fields: Readonly<Record<string, ObservedFieldShape>>;
}

/** Union membership alone is insufficient: native request shapes are reviewed too. */
export const CAPABILITY_FEATURE_POLICIES: Readonly<
  Record<CapabilityFeature, CapabilityFeaturePolicy>
> = Object.freeze({
  experimental_api: {
    members: Object.freeze([{ surface: "client_request", name: "initialize" }]),
    fields: Object.freeze({
      "InitializeCapabilities.experimentalApi": {
        required: true,
        kinds: ["boolean"],
      },
    }),
  },
  request_user_input: {
    members: Object.freeze([
      { surface: "server_request", name: "item/tool/requestUserInput" },
      { surface: "response", name: "ToolRequestUserInputResponse" },
    ]),
    fields: Object.freeze({
      "ToolRequestUserInputParams.threadId": { required: true, kinds: ["string"] },
      "ToolRequestUserInputParams.turnId": { required: true, kinds: ["string"] },
      "ToolRequestUserInputParams.itemId": { required: true, kinds: ["string"] },
      "ToolRequestUserInputParams.questions": { required: true, kinds: ["array"] },
      "ToolRequestUserInputQuestion.id": { required: true, kinds: ["string"] },
      "ToolRequestUserInputQuestion.header": { required: true, kinds: ["string"] },
      "ToolRequestUserInputQuestion.question": {
        required: true,
        kinds: ["string"],
      },
      "ToolRequestUserInputQuestion.isOther": {
        required: true,
        kinds: ["boolean"],
      },
      "ToolRequestUserInputQuestion.isSecret": {
        required: true,
        kinds: ["boolean"],
      },
      "ToolRequestUserInputQuestion.options": {
        required: true,
        kinds: ["array", "null"],
      },
      "ToolRequestUserInputOption.label": { required: true, kinds: ["string"] },
      "ToolRequestUserInputOption.description": {
        required: true,
        kinds: ["string"],
      },
      "ToolRequestUserInputResponse.answers": {
        required: true,
        kinds: ["object"],
      },
      "ToolRequestUserInputAnswer.answers": { required: true, kinds: ["array"] },
    }),
  },
} as const satisfies Record<CapabilityFeature, CapabilityFeaturePolicy>);

function sameShape(left: ObservedFieldShape, right: ObservedFieldShape): boolean {
  const kinds = new Set(left.kinds);
  return (
    left.required === right.required &&
    kinds.size === right.kinds.length &&
    right.kinds.every((kind) => kinds.has(kind))
  );
}

export function supportsCapabilityFeature(
  observation: ProtocolObservation,
  feature: CapabilityFeature,
): boolean {
  const policy = CAPABILITY_FEATURE_POLICIES[feature];
  return (
    policy.members.every((member) =>
      observation.members[member.surface]?.includes(member.name),
    ) &&
    Object.entries(policy.fields).every(([path, required]) => {
      const observed = observation.fields[path];
      return observed !== undefined && sameShape(observed, required);
    })
  );
}
