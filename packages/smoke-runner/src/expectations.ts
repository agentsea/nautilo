/**
 * Expectations loader — reads expected-outcomes.json and normalizes
 * each row into one TestSpec per (test, platform) pair.
 *
 * The JSON file's schema allows per-platform command overrides
 * (destructive_command_linux / _macos); this loader materializes one
 * spec per platform with the resolved command.
 *
 * D063 Phase 2 task 2.7 helper.
 */

import { readFile } from "node:fs/promises";
import type {
  Platform,
  SecurityLevel,
  TestSpec,
  TestLayer,
  Mode,
} from "./types.ts";

interface RawEntry {
  platforms?: string[];
  layer?: string;
  description?: string;
  destructive_command?: string | null;
  destructive_command_linux?: string | null;
  destructive_command_macos?: string | null;
  substitution_command?: string | null;
  modes_supported?: string[];
  expect_blocked?: boolean;
  expect_message_contains?: string[];
  honeypot_required?: boolean;
  security_levels?: string[];
  timeout_ms?: number;
  env_overrides?: Record<string, string>;
  actor?: string;
  setup_notes?: string;
  // D063 Phase 6 — tool-invocation tests
  tool_invocation?: {
    tool?: string;
    args?: Record<string, unknown>;
    workspace_root?: string;
    current_folder?: string;
    deployment_mode?: string;
    network_policy?: unknown;
  };
  expect_layer_hit?: string;
}

interface RawFile {
  version?: string;
  description?: string;
  tests?: Record<string, RawEntry>;
}

export class Expectations {
  private readonly specsById: Map<string, TestSpec[]> = new Map();

  constructor(rawTests: Record<string, RawEntry>) {
    for (const [id, raw] of Object.entries(rawTests)) {
      const platforms = (raw.platforms ?? []).filter(isPlatform);
      if (platforms.length === 0) continue;

      const specs: TestSpec[] = [];
      for (const platform of platforms) {
        const destructive = resolveDestructive(platform, raw);
        specs.push({
          id,
          platform,
          applicablePlatforms: platforms,
          layer: (raw.layer ?? "command-scanner") as TestLayer,
          description: raw.description ?? id,
          destructiveCommand: destructive,
          substitutionCommand: raw.substitution_command ?? null,
          modesSupported: (raw.modes_supported ?? ["destructive"]).filter(isMode),
          expectBlocked: raw.expect_blocked ?? true,
          expectMessageContains: raw.expect_message_contains ?? [],
          honeypotRequired: raw.honeypot_required ?? false,
          securityLevels: (raw.security_levels ?? ["standard"]).filter(isSecurityLevel),
          timeoutMs: raw.timeout_ms ?? 10_000,
          ...(raw.env_overrides !== undefined ? { envOverrides: raw.env_overrides } : {}),
          ...(raw.actor !== undefined ? { actor: raw.actor } : {}),
          ...(raw.setup_notes !== undefined ? { setupNotes: raw.setup_notes } : {}),
          ...(raw.tool_invocation !== undefined &&
          typeof raw.tool_invocation.tool === "string" &&
          typeof raw.tool_invocation.args === "object" &&
          raw.tool_invocation.args !== null
            ? {
                toolInvocation: {
                  tool: raw.tool_invocation.tool,
                  args: raw.tool_invocation.args,
                  ...(typeof raw.tool_invocation.workspace_root === "string"
                    ? { workspaceRoot: raw.tool_invocation.workspace_root }
                    : {}),
                  ...(typeof raw.tool_invocation.current_folder === "string"
                    ? { currentFolder: raw.tool_invocation.current_folder }
                    : {}),
                  ...(isDeploymentMode(raw.tool_invocation.deployment_mode)
                    ? { deploymentMode: raw.tool_invocation.deployment_mode }
                    : {}),
                  ...(isNetworkPolicy(raw.tool_invocation.network_policy)
                    ? { networkPolicy: raw.tool_invocation.network_policy }
                    : {}),
                },
              }
            : {}),
          ...(isExpectLayerHit(raw.expect_layer_hit)
            ? { expectLayerHit: raw.expect_layer_hit }
            : {}),
        });
      }
      this.specsById.set(id, specs);
    }
  }

  static async load(path: string): Promise<Expectations> {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as RawFile;
    return new Expectations(parsed.tests ?? {});
  }

  /** Get all specs, optionally filtered by platform + pattern (simple glob). */
  list(filter?: { platform?: Platform; pattern?: string; layer?: TestLayer }): readonly TestSpec[] {
    const out: TestSpec[] = [];
    for (const specs of this.specsById.values()) {
      for (const spec of specs) {
        if (filter?.platform && spec.platform !== filter.platform) continue;
        if (filter?.layer && spec.layer !== filter.layer) continue;
        if (filter?.pattern && !matchGlob(spec.id, filter.pattern)) continue;
        out.push(spec);
      }
    }
    return out;
  }

  /** Get one spec by id+platform. Returns undefined if missing. */
  get(id: string, platform: Platform): TestSpec | undefined {
    const specs = this.specsById.get(id);
    return specs?.find((s) => s.platform === platform);
  }

  /** All unique test ids. */
  ids(): readonly string[] {
    return [...this.specsById.keys()].sort();
  }
}

function isPlatform(s: string): s is Platform {
  return s === "linux" || s === "macos";
}

function isMode(s: string): s is Mode {
  return s === "destructive" || s === "substitution";
}

function isSecurityLevel(s: string): s is SecurityLevel {
  return ["yolo", "permissive", "standard", "cautious", "paranoid"].includes(s);
}

function isDeploymentMode(s: unknown): s is NonNullable<TestSpec["toolInvocation"]>["deploymentMode"] {
  return s === "server" || s === "desktop-permissive" || s === "desktop-locked";
}

function isNetworkPolicy(
  v: unknown,
): v is NonNullable<NonNullable<TestSpec["toolInvocation"]>["networkPolicy"]> {
  if (typeof v !== "object" || v === null) return false;
  const policy = v as Record<string, unknown>;
  if (policy["mode"] === "host" || policy["mode"] === "isolated") return true;
  if (policy["mode"] !== "proxy-allowlist") return false;
  return Array.isArray(policy["allow"]);
}

function isExpectLayerHit(
  s: string | undefined,
): s is NonNullable<TestSpec["expectLayerHit"]> {
  if (s === undefined) return false;
  return [
    "validate-before-execution",
    "trust-envelope",
    "zone-resolver",
    "realpath-containment",
    "handler",
    "unknown",
  ].includes(s);
}

function resolveDestructive(platform: Platform, raw: RawEntry): string | null {
  const perPlatform =
    platform === "linux"
      ? raw.destructive_command_linux
      : raw.destructive_command_macos;
  if (perPlatform !== undefined) return perPlatform;
  return raw.destructive_command ?? null;
}

/** Simple glob: only supports `*` (any chars). E.g. `PATH-*` matches `PATH-01`. */
function matchGlob(s: string, pattern: string): boolean {
  const regex = new RegExp(
    "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
  );
  return regex.test(s);
}
