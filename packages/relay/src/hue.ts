import { homedir } from "node:os";
import { join } from "node:path";
import { discoverMacHueBridges, type HueBridgeCandidate } from "./hue-discovery";

/**
 * Relay-only OpenHue adapter. It deliberately accepts a small typed action
 * schema instead of exposing the OpenHue CLI's general argv surface.
 */
export const OPENHUE_ACTIONS = [
  "discover",
  "setup",
  "list_lights",
  "list_rooms",
  "list_scenes",
  "set_light",
  "set_room",
  "activate_scene",
] as const;

export type OpenHueAction = (typeof OPENHUE_ACTIONS)[number];

export interface OpenHueExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface OpenHueExecutor {
  execute(
    binary: string,
    argv: readonly string[],
    options: { readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number },
  ): Promise<OpenHueExecResult>;
}

export interface OpenHueHandlerOptions {
  readonly executor: OpenHueExecutor;
  readonly binaryPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  /** Clamped to 1–120 seconds because OpenHue setup waits for a button press. */
  readonly setupTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  /** Retryable native discovery observation window, within the action deadline. */
  readonly discoveryTimeoutMs?: number;
  /** Test seam; discovery follows the relay host's OS, never a caller argument. */
  readonly platform?: NodeJS.Platform;
}

export type OpenHueDispatchResult =
  | { readonly status: "ok"; readonly result: unknown }
  | { readonly status: "error"; readonly error: string; readonly errorCode: string };

type ArgvResult = { readonly ok: true; readonly action: OpenHueAction; readonly argv: string[] }
  | { readonly ok: false; readonly error: string };

const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
export const DEFAULT_SETUP_TIMEOUT_MS = 120_000;
const MAX_SETUP_TIMEOUT_MS = 120_000;

export function isOpenHueAction(value: string): value is OpenHueAction {
  return (OPENHUE_ACTIONS as readonly string[]).includes(value);
}

function nonEmptyString(args: Record<string, unknown>, key: string, action: string): string | null {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`hue ${action} requires a non-empty string \`${key}\`.`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`hue \`${key}\` must be a non-empty string when provided.`);
  }
  return value;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`hue \`${key}\` must be a boolean when provided.`);
  return value;
}

function optionalBoundedNumber(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`hue \`${key}\` must be a number from ${min} to ${max}.`);
  }
  return value;
}

function optionalRgbTuple(args: Record<string, unknown>): string | undefined {
  const value = args["rgb"];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value)
    || value.length !== 3
    || !value.every((channel) => typeof channel === "number" && Number.isInteger(channel) && channel >= 0 && channel <= 255)
  ) {
    throw new Error("hue `rgb` must be exactly three integer channels from 0 to 255.");
  }
  const channels = value as number[];
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function appendState(argv: string[], args: Record<string, unknown>, action: "set_light" | "set_room"): void {
  const on = optionalBoolean(args, "on");
  const brightness = optionalBoundedNumber(args, "brightness", 0, 100);
  const temperature = optionalBoundedNumber(args, "temperature", 153, 500);
  const rgb = optionalRgbTuple(args);
  const rawTransition = args["transitionTime"];
  if (typeof rawTransition === "number" && (!Number.isFinite(rawTransition) || rawTransition < 0)) {
    throw new Error("hue `transitionTime` must be a finite non-negative duration in milliseconds.");
  }
  const transitionTime = typeof rawTransition === "number"
    ? `${rawTransition}ms`
    : optionalString(args, "transitionTime");

  if ((brightness !== undefined || temperature !== undefined || rgb !== undefined) && on !== true) {
    throw new Error(`hue ${action} requires \`on: true\` with brightness, temperature, or rgb.`);
  }
  if (on === undefined && brightness === undefined && temperature === undefined && rgb === undefined) {
    throw new Error(`hue ${action} requires \`on\`, brightness, temperature, or rgb.`);
  }

  if (on === true) argv.push("--on");
  if (on === false) argv.push("--off");
  if (brightness !== undefined) argv.push("--brightness", String(brightness));
  if (temperature !== undefined) argv.push("--temperature", String(temperature));
  if (rgb !== undefined) argv.push("--rgb", rgb);
  if (transitionTime !== undefined) argv.push("--transition-time", transitionTime);
}

/**
 * Converts the fixed Hue action schema into argv for OpenHue 0.24, excluding
 * the binary. No caller-provided argv or command text is ever forwarded.
 */
export function openHueArgv(args: Record<string, unknown>): ArgvResult {
  try {
    const rawAction = args["action"];
    if (typeof rawAction !== "string" || !isOpenHueAction(rawAction)) {
      return { ok: false, error: `hue action must be one of: ${OPENHUE_ACTIONS.join(", ")}.` };
    }

    switch (rawAction) {
      case "discover":
        return { ok: true, action: rawAction, argv: ["discover"] };
      case "setup": {
        const bridge = optionalString(args, "bridge");
        const deviceType = optionalString(args, "devicetype");
        return {
          ok: true,
          action: rawAction,
          argv: ["setup", ...(bridge ? ["--bridge", bridge] : []), ...(deviceType ? ["--devicetype", deviceType] : [])],
        };
      }
      case "list_lights": {
        const room = optionalString(args, "room");
        return { ok: true, action: rawAction, argv: ["get", "light", ...(room ? ["--room", room] : []), "--json"] };
      }
      case "list_rooms":
        return { ok: true, action: rawAction, argv: ["get", "room", "--json"] };
      case "list_scenes": {
        const room = optionalString(args, "room");
        return { ok: true, action: rawAction, argv: ["get", "scene", ...(room ? ["--room", room] : []), "--json"] };
      }
      case "set_light": {
        const name = nonEmptyString(args, "name", rawAction)!;
        const argv = ["set", "light", name];
        appendState(argv, args, rawAction);
        return { ok: true, action: rawAction, argv };
      }
      case "set_room": {
        const name = nonEmptyString(args, "name", rawAction)!;
        const argv = ["set", "room", name];
        appendState(argv, args, rawAction);
        return { ok: true, action: rawAction, argv };
      }
      case "activate_scene": {
        const name = nonEmptyString(args, "name", rawAction)!;
        const room = optionalString(args, "room");
        const dynamic = optionalBoolean(args, "dynamic");
        return {
          ok: true,
          action: rawAction,
          argv: ["set", "scene", name, ...(room ? ["--room", room] : []), ...(dynamic === true ? ["--action", "dynamic"] : [])],
        };
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function isExpectedFailure(output: string): boolean {
  return /\[KO\]|(?:too many attempts to discover the bridge via URL|no (?:light|room|scene)|not found|unable to|failed to|error:|not configured)/i.test(output);
}

function classifyFailure(output: string, timedOut: boolean): string {
  if (timedOut) return "hue_setup_timeout";
  if (/too many attempts to discover the bridge via URL/i.test(output)) {
    return "hue_bridge_discovery_failed";
  }
  if (/not configured|config(?:uration)? .*not found/i.test(output)) return "hue_not_configured";
  if (/no bridge found|unable to discover|bridge.*not found/i.test(output)) return "hue_bridge_not_found";
  if (/openhue api error: (?:404|wrong API key)|no such host|connection refused|host is down|no route to host/i.test(output)) return "hue_bridge_unavailable";
  if (/no (?:light|room|scene)|not found/i.test(output)) return "hue_not_found";
  return "hue_command_failed";
}

function userFacingFailure(output: string, errorCode: string): string {
  if (errorCode === "hue_bridge_discovery_failed" || errorCode === "hue_bridge_not_found") {
    return (
      "Could not discover a Hue Bridge from this Mac. Check that the Bridge is powered on and " +
      "on the same local network, then run discover again. Only if fresh discovery still fails, " +
      "ask for its address from the Hue app and run setup; do not treat this as rate limiting."
    );
  }
  return output;
}

function normalizeJsonList(stdout: string): unknown[] {
  const parsed: unknown = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function timeoutFor(action: OpenHueAction, options: OpenHueHandlerOptions): number {
  if (action === "setup") {
    const requested = options.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS;
    return Math.max(1, Math.min(requested, MAX_SETUP_TIMEOUT_MS));
  }
  return Math.max(1, options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
}

/** Creates a dispatch-ready handler for use before sandbox resolution. */
export function createOpenHueHandler(options: OpenHueHandlerOptions): (args: Record<string, unknown>) => Promise<OpenHueDispatchResult> {
  const env = { ...(options.env ?? process.env) };
  env["XDG_CONFIG_HOME"] ??= join(options.homeDir ?? homedir(), ".nautilo");
  const binary = options.binaryPath ?? "openhue";

  return async (args) => {
    const mapped = openHueArgv(args);
    if (!mapped.ok) return { status: "error", error: mapped.error, errorCode: "hue_invalid_request" };

    const deadline = Date.now() + timeoutFor(mapped.action, options);
    const remaining = () => Math.max(0, deadline - Date.now());
    const discover = async (): Promise<HueBridgeCandidate[]> => {
      try {
        return await discoverMacHueBridges({
          executor: options.executor, env, timeoutMs: remaining(),
          platform: options.platform ?? process.platform,
          browseWindowMs: options.discoveryTimeoutMs,
        });
      } catch {
        // Native discovery is a fallback path; retain OpenHue on other hosts
        // and when the native resolver is unavailable or denied.
        return [];
      }
    };
    try {
      let argv = mapped.argv;
      if (mapped.action === "discover" || (mapped.action === "setup" && args["bridge"] === undefined)) {
        const bridges = await discover();
        if (bridges.length > 0 && mapped.action === "discover") {
          return { status: "ok", result: { bridges, discoveryComplete: false,
            message: "Fresh local discovery. Use a returned stable bridge hostname for setup; this observation is not an exhaustive network inventory." } };
        }
        if (bridges.length > 1) {
          return { status: "error", errorCode: "hue_bridge_selection_required",
            error: `Multiple Hue Bridges were discovered. Ask which Bridge to pair, then run setup with its bridge hostname: ${JSON.stringify(bridges)}` };
        }
        if (bridges.length === 1) argv = [...mapped.argv, "--bridge", bridges[0]!.bridge];
      }
      const executionTimeoutMs = remaining();
      if (executionTimeoutMs === 0) {
        return { status: "error", errorCode: "hue_discovery_timeout",
          error: "Hue discovery used this attempt's deadline. Run discover again; no pairing or lighting command was started." };
      }
      const execution = await options.executor.execute(binary, argv, {
        env,
        timeoutMs: executionTimeoutMs,
      });
      const output = [execution.stdout, execution.stderr].filter(Boolean).join("\n").trim();
      const timedOut = /timed?\s*out|timeout/i.test(output);
      if (execution.exitCode !== 0 || isExpectedFailure(output)) {
        const errorCode = classifyFailure(output, timedOut);
        if (errorCode === "hue_bridge_unavailable" || errorCode === "hue_not_configured") {
          const bridges = await discover();
          return { status: "error", errorCode,
            error: "The saved Hue address or pairing is unavailable. " +
              (bridges.length > 0
                ? `Fresh local discovery found: ${JSON.stringify(bridges)}. Run setup with the chosen stable bridge hostname, then list_lights to verify. `
                : "Run discover to search for the Bridge again, then setup with the discovered address. ") +
              "Pairing needs the physical Bridge button. No lighting command was retried; observe current state before deciding whether to repeat a change." };
        }
        return {
          status: "error",
          error: userFacingFailure(
            output || `OpenHue exited with code ${execution.exitCode}.`,
            errorCode,
          ),
          errorCode,
        };
      }
      if (mapped.action.startsWith("list_")) {
        try {
          return { status: "ok", result: normalizeJsonList(execution.stdout) };
        } catch {
          return {
            status: "error",
            error: "OpenHue returned invalid JSON for a list action.",
            errorCode: "hue_invalid_response",
          };
        }
      }
      return { status: "ok", result: { stdout: execution.stdout, stderr: execution.stderr } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "error",
        error: message,
        errorCode: classifyFailure(message, /timed?\s*out|timeout/i.test(message)),
      };
    }
  };
}
