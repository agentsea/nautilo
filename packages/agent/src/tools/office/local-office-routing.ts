/**
 * M206 Phase 3 — relay selection for local-zone OfficeCLI / office.run dispatch.
 *
 * Requires protocol v4+, `profile:"desktop-agent"`, `localFileExecution:true`,
 * and `canRunOffice:true` (advertised only after desktop binary probe succeeds).
 */

import {
  LOCAL_FILE_EXECUTION_UNSUPPORTED,
} from "@nautilo/relay";
import type { ToolRelayRegistry } from "../../nodes/tools";
import {
  FOCUSED_RELAY_MISMATCH_MESSAGE,
  RELAY_OWNERSHIP_MISMATCH,
} from "../file/local-file-routing";

export type LocalOfficeZone = "current" | "absolute";

// Local OfficeCLI dispatch shares M206's v4 local-file transport. D417's v5
// media operation must not strand a capable v4 desktop relay.
const LOCAL_OFFICE_PROTOCOL_VERSION = 4;

const DESKTOP_OFFICE_REQUIRED_MESSAGE =
  "Office operations on zone=\"current\" or zone=\"absolute\" require the Nautilo " +
  "desktop app with local file execution and a bundled OfficeCLI runtime. Open the " +
  "Nautilo desktop app on your Mac, ensure it is connected to this server, and retry. " +
  "Headless relay, server-side OfficeCLI, and server filesystem access are not " +
  "supported for local office files.";

export type LocalOfficeRelaySelection =
  | { ok: true; relayId: string; allowedRoots: readonly string[] }
  | {
      ok: false;
      error: string;
      code: typeof LOCAL_FILE_EXECUTION_UNSUPPORTED | typeof RELAY_OWNERSHIP_MISMATCH;
    };

function relayQualifies(registry: ToolRelayRegistry, relayId: string): boolean {
  const caps = registry.getCapabilities(relayId);
  if (!caps || caps.profile !== "desktop-agent") return false;
  if (caps.localFileExecution !== true) return false;
  if (caps.canRunOffice !== true) return false;
  const version = registry.getProtocolVersion?.(relayId);
  return typeof version === "number" && version >= LOCAL_OFFICE_PROTOCOL_VERSION;
}

export function isLocalOfficeMutating(args: {
  subkind: "officecli" | "officeRun" | "convert";
  command?: string | undefined;
  mode?: "read" | "write" | undefined;
}): boolean {
  if (args.subkind === "convert") return true;
  if (args.subkind === "officeRun") return args.mode === "write";
  if (args.subkind === "officecli") {
    const readOnly = new Set([
      "view",
      "get",
      "query",
      "validate",
      "dump",
      "raw",
      "help",
    ]);
    return args.command !== undefined && !readOnly.has(args.command);
  }
  return false;
}

/**
 * Pick the paired-owner relay that can execute typed local Office operations.
 */
export function resolveLocalOfficeRelay(args: {
  ownerId: string;
  mutating: boolean;
  registry: ToolRelayRegistry | null;
  /**
   * D423 Phase 5 — when set, dispatch must target this relay exactly (a
   * focused local-file ref's originating relay). A hint that is not the
   * connected, owner-paired, qualifying Office relay fails closed with
   * `RELAY_OWNERSHIP_MISMATCH` rather than falling back to another relay.
   */
  relayIdHint?: string | undefined;
  /** D423 Phase 5 — message returned with `RELAY_OWNERSHIP_MISMATCH` on a missed hint. */
  relayHintMismatchMessage?: string | undefined;
}): LocalOfficeRelaySelection {
  const { ownerId, mutating, registry } = args;
  const mismatchMessage = args.relayHintMismatchMessage ?? FOCUSED_RELAY_MISMATCH_MESSAGE;
  const relayIdHint = args.relayIdHint;

  if (!registry?.localFileDispatch) {
    return {
      ok: false,
      error: DESKTOP_OFFICE_REQUIRED_MESSAGE,
      code: LOCAL_FILE_EXECUTION_UNSUPPORTED,
    };
  }

  const capability = mutating ? "canWriteWorkspace" : "canReadWorkspace";
  const candidates = registry.findByCapabilityForUser(capability, ownerId);

  if (relayIdHint) {
    if (!candidates.includes(relayIdHint) || !relayQualifies(registry, relayIdHint)) {
      return { ok: false, error: mismatchMessage, code: RELAY_OWNERSHIP_MISMATCH };
    }
    const allowedRoots = registry.getCapabilities(relayIdHint)?.allowedRoots ?? [];
    return { ok: true, relayId: relayIdHint, allowedRoots: [...allowedRoots] };
  }

  const relayId = candidates.find((id) => relayQualifies(registry, id));
  if (!relayId) {
    return {
      ok: false,
      error: DESKTOP_OFFICE_REQUIRED_MESSAGE,
      code: LOCAL_FILE_EXECUTION_UNSUPPORTED,
    };
  }

  const allowedRoots = registry.getCapabilities(relayId)?.allowedRoots ?? [];
  return { ok: true, relayId, allowedRoots: [...allowedRoots] };
}
