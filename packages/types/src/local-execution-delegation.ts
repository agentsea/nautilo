/** A server-authored reference to existing Desktop authority. This record is
 * safe to persist on a Task, but is never sufficient to authorize execution. */
export interface LocalExecutionDelegation {
  readonly version: 1;
  readonly humanUserId: string;
  readonly agentId: string;
  readonly sourceRoomId: string;
  readonly sourceConversationId: string;
  readonly rootTaskId: string;
  readonly target: {
    readonly instanceId: string;
    readonly relayId: string;
    readonly pairingGeneration: string;
    readonly serverOrigin: string;
    readonly serverFingerprint: string;
  };
  readonly projectGrantId: string;
  readonly ceiling: "basic" | "development";
  readonly profile: { readonly id: string; readonly revision: number } | null;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));

export function parseLocalExecutionDelegation(value: unknown): LocalExecutionDelegation | null {
  if (!record(value) || !exact(value, ["version", "humanUserId", "agentId", "sourceRoomId",
    "sourceConversationId", "rootTaskId", "target", "projectGrantId", "ceiling", "profile"])
    || value["version"] !== 1) return null;
  for (const key of ["humanUserId", "agentId", "sourceRoomId", "sourceConversationId", "rootTaskId", "projectGrantId"]) {
    if (!text(value[key])) return null;
  }
  const target = value["target"];
  if (!record(target) || !exact(target, ["instanceId", "relayId", "pairingGeneration", "serverOrigin", "serverFingerprint"])
    || typeof target["instanceId"] !== "string" || target["instanceId"].trim() !== target["instanceId"]
    || !text(target["relayId"]) || !text(target["pairingGeneration"]) || !text(target["serverFingerprint"])
    || !text(target["serverOrigin"])) return null;
  try {
    const origin = new URL(target["serverOrigin"]);
    if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== target["serverOrigin"]
      || origin.username || origin.password) return null;
  } catch { return null; }
  const profile = value["profile"];
  if (value["ceiling"] === "basic") {
    if (profile !== null) return null;
  } else if (value["ceiling"] === "development") {
    if (!record(profile) || !exact(profile, ["id", "revision"]) || !text(profile["id"])
      || !Number.isSafeInteger(profile["revision"]) || (profile["revision"] as number) < 1) return null;
  } else return null;
  return structuredClone(value) as unknown as LocalExecutionDelegation;
}

/** The task lineage is narrower than the ordinary all-owned-Agents grant. */
export function localExecutionDelegationGrantScope(rootTaskId: string): string {
  if (!text(rootTaskId)) throw new TypeError("Task lineage identity is required");
  return `task:${rootTaskId}`;
}
