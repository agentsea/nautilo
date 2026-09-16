import type { ToolCall } from "@langchain/core/messages/tool";
import type { NetworkAllowRule } from "@nautilo/config";
import { dirname, isAbsolute, join, normalize } from "node:path";

export interface ApprovalPathContext {
  readonly currentFolder?: string;
  readonly workspacePath?: string;
}

const writableByLane = new Map<string, Set<string>>();
const oneShotNetworkAllowByLane = new Map<string, Map<string, Map<string, NetworkAllowRule>>>();

const NETWORK_RULE_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_NETWORK_RULES_PER_LANE = 64;

interface TimedNetworkRule {
  readonly rule: NetworkAllowRule;
  readonly createdAt: number;
}

const timedNetworkAllowByLane = new Map<string, Map<string, TimedNetworkRule>>();

export function approvalToolKey(tc: Pick<ToolCall, "id" | "name" | "args">): string {
  if (tc.id) return `id:${tc.id}`;
  try {
    return `${tc.name}:${JSON.stringify(tc.args ?? {})}`;
  } catch {
    return `${tc.name}:<unserializable>`;
  }
}

export function recordApprovedWritablePath(laneKey: string, path: string): void {
  if (!laneKey || !path) return;
  const existing = writableByLane.get(laneKey) ?? new Set<string>();
  existing.add(normalize(path));
  writableByLane.set(laneKey, existing);
}

export function approvedWritablePathsForLane(laneKey: string): readonly string[] {
  return Array.from(writableByLane.get(laneKey) ?? []).sort();
}

export function recordApprovedNetworkAllowRule(
  laneKey: string,
  rule: NetworkAllowRule,
): void {
  if (!laneKey) return;
  pruneExpiredNetworkRules(laneKey);
  const existing = timedNetworkAllowByLane.get(laneKey) ?? new Map<string, TimedNetworkRule>();
  existing.set(networkRuleKey(rule), { rule, createdAt: Date.now() });
  while (existing.size > MAX_NETWORK_RULES_PER_LANE) {
    const oldest = Array.from(existing.entries())
      .sort(([, a], [, b]) => a.createdAt - b.createdAt)[0]?.[0];
    if (oldest === undefined) break;
    existing.delete(oldest);
  }
  timedNetworkAllowByLane.set(laneKey, existing);
}

export function approvedNetworkAllowRulesForLane(
  laneKey: string,
): readonly NetworkAllowRule[] {
  pruneExpiredNetworkRules(laneKey);
  return Array.from(timedNetworkAllowByLane.get(laneKey)?.entries() ?? [])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, entry]) => entry.rule);
}

export function recordOneShotNetworkAllowRule(
  laneKey: string,
  toolKey: string,
  rule: NetworkAllowRule,
): void {
  if (!laneKey || !toolKey) return;
  const byTool = oneShotNetworkAllowByLane.get(laneKey) ?? new Map<string, Map<string, NetworkAllowRule>>();
  const existing = byTool.get(toolKey) ?? new Map<string, NetworkAllowRule>();
  existing.set(networkRuleKey(rule), rule);
  byTool.set(toolKey, existing);
  oneShotNetworkAllowByLane.set(laneKey, byTool);
}

export function consumeOneShotNetworkAllowRulesForTool(
  laneKey: string,
  toolKey: string,
): readonly NetworkAllowRule[] {
  const byTool = oneShotNetworkAllowByLane.get(laneKey);
  const rules = byTool?.get(toolKey);
  if (rules === undefined) return [];
  byTool?.delete(toolKey);
  if (byTool !== undefined && byTool.size === 0) {
    oneShotNetworkAllowByLane.delete(laneKey);
  }
  return Array.from(rules.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, rule]) => rule);
}

export function clearApprovedWritablePathsForTests(): void {
  writableByLane.clear();
  timedNetworkAllowByLane.clear();
  oneShotNetworkAllowByLane.clear();
}

export function extractApprovedWritablePath(
  tc: ToolCall,
  ctx: ApprovalPathContext,
): string | null {
  const args = isRecord(tc.args) ? tc.args : {};
  if (tc.name !== "file") return null;
  const command = stringArg(args["command"]);
  if (!isFileWriteCommand(command)) return null;

  const zone = stringArg(args["zone"]) ?? "workspace";
  if (command === "move" || command === "copy") {
    const destinationZone = stringArg(args["destinationZone"]) ?? zone;
    return writableParentForZone(
      args["destinationPath"],
      destinationZone,
      ctx,
    );
  }
  return writableParentForZone(args["path"], zone, ctx);
}

function stringArg(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function resolvePathArg(v: unknown, root?: string): string | null {
  const p = stringArg(v);
  if (p === null) return null;
  if (isAbsolute(p)) return normalize(p);
  if (root === undefined || root.length === 0) return null;
  return normalize(join(root, p));
}

function writableParentForPathArg(v: unknown, root?: string): string | null {
  const resolved = resolvePathArg(v, root);
  return resolved === null ? null : dirname(resolved);
}

function writableParentForZone(
  v: unknown,
  zone: string,
  ctx: ApprovalPathContext,
): string | null {
  if (zone === "absolute") return writableParentForPathArg(v);
  if (zone === "current") return writableParentForPathArg(v, ctx.currentFolder);
  if (zone === "scratch") {
    const scratchRoot =
      ctx.workspacePath === undefined ? undefined : join(ctx.workspacePath, "scratch");
    return writableParentForPathArg(v, scratchRoot);
  }
  if (zone === "workspace" || zone === "home") {
    return writableParentForPathArg(v, ctx.workspacePath);
  }
  return null;
}

function isFileWriteCommand(command: string | null): boolean {
  if (command === null) return false;
  return new Set([
    "write",
    "str_replace",
    "insert",
    "delete",
    "move",
    "copy",
  ]).has(command);
}

function networkRuleKey(rule: NetworkAllowRule): string {
  const ports = [...(rule.ports ?? [])].sort((a, b) => a - b).join(",");
  switch (rule.type) {
    case "domain":
      return `domain:${rule.host}:${ports}`;
    case "wildcard":
      return `wildcard:${rule.suffix}:${ports}`;
    case "cidr":
      return `cidr:${rule.cidr}:${ports}`;
  }
}

function pruneExpiredNetworkRules(laneKey: string): void {
  const existing = timedNetworkAllowByLane.get(laneKey);
  if (existing === undefined) return;
  const cutoff = Date.now() - NETWORK_RULE_TTL_MS;
  for (const [key, value] of existing.entries()) {
    if (value.createdAt < cutoff) existing.delete(key);
  }
  if (existing.size === 0) timedNetworkAllowByLane.delete(laneKey);
}
