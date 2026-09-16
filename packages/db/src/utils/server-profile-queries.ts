import { randomInt } from "node:crypto";
import { eq, isNull, or } from "drizzle-orm";
import { NAUTILO_PRODUCT_NAME } from "@nautilo/config";
import {
  LEGACY_SERVER_ICON_PRESET_ID,
  SERVER_ICON_PRESET_IDS,
  type AvatarRef,
} from "@nautilo/types";
import type { Database } from "../config/database";
import {
  serverProfile,
  type NewServerProfileRow,
  type ServerProfileRow,
} from "../schema/server-profile";

const SERVER_PROFILE_ID = "server";

const DEFAULT_SERVER_ICON = {
  kind: "preset",
  id: LEGACY_SERVER_ICON_PRESET_ID,
} as const satisfies AvatarRef;

export interface ResolvedServerProfile {
  name: string;
  description: string | null;
  descriptionVisibility: "public" | "members";
  icon: AvatarRef;
  reviewedAt: Date | null;
}

export interface ResolveServerProfileOpts {
  /**
   * Default name when the row has none (R6). Callers compute it from the
   * server's host/instance via `deriveDefaultServerName`; falls back to the
   * product name if omitted.
   */
  defaultName?: string | null;
}

export interface MaterializeDefaultServerProfileOpts extends ResolveServerProfileOpts {
  /** Test seam; production uses crypto.randomInt. */
  randomIndex?: (upperBound: number) => number;
}

const GENERIC_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "ubuntu",
  "app",
  "server",
  "host",
]);

function extractHostname(host: string): string {
  let h = host.trim();
  if (h === "") return "";
  // Strip scheme + path if a URL was passed.
  if (h.includes("://")) {
    try {
      h = new URL(h).hostname;
    } catch {
      h = h.replace(/^[a-z]+:\/\//i, "");
    }
  }
  // Strip any leftover path and port.
  h = h.split("/")[0] ?? h;
  h = h.replace(/:\d+$/, "");
  return h.toLowerCase();
}

function isGenericOrIp(hostname: string): boolean {
  if (hostname === "" || GENERIC_HOSTS.has(hostname)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true; // IPv4
  if (hostname.includes(":")) return true; // IPv6
  return false;
}

function titleCaseLabel(label: string): string {
  return label
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Deterministic 4-char hash (djb2) for the generic-host fallback suffix. */
function shortHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  }
  // Modulo over the 4-char base36 space (36^4) uses the low-order bits, which
  // carry more entropy than the leading digits — avoids near-input collisions.
  return (h % 1_679_616).toString(36).padStart(4, "0");
}

/**
 * R6 — deterministic default server name. Host-derived when the host is
 * meaningful (`kentauros.nautilo.dev` → `Kentauros`), else a branded,
 * instance-stable fallback (`Nautilo 7f3a`). Never random per request.
 */
export function deriveDefaultServerName(opts: {
  host?: string | null;
  instanceId?: string | null;
}): string {
  const hostname = extractHostname(opts.host ?? "");
  if (!isGenericOrIp(hostname)) {
    const labels = hostname.split(".").filter(Boolean);
    const first = labels[0] === "www" ? labels[1] : labels[0];
    if (first) return titleCaseLabel(first);
  }
  const id = (opts.instanceId ?? "").trim();
  if (id !== "") return `${NAUTILO_PRODUCT_NAME} ${shortHash(id)}`;
  return NAUTILO_PRODUCT_NAME;
}

export type ServerProfilePatch = Partial<
  Pick<NewServerProfileRow, "name" | "description" | "descriptionVisibility" | "icon" | "reviewedAt">
>;

export type ServerProfileDb = Pick<Database, "insert" | "select">;

/**
 * Pure default-fallback resolver (R6). No DB I/O.
 */
export function resolveServerProfile(
  row: ServerProfileRow | null | undefined,
  opts?: ResolveServerProfileOpts,
): ResolvedServerProfile {
  const visibility = row?.descriptionVisibility;
  const descriptionVisibility: ResolvedServerProfile["descriptionVisibility"] =
    visibility === "members" ? "members" : "public";

  return {
    name: row?.name ?? opts?.defaultName ?? NAUTILO_PRODUCT_NAME,
    description: row?.description ?? null,
    descriptionVisibility,
    icon: (row?.icon) ?? DEFAULT_SERVER_ICON,
    reviewedAt: row?.reviewedAt ?? null,
  };
}

export async function getServerProfile(
  db: ServerProfileDb,
  opts?: ResolveServerProfileOpts,
): Promise<ResolvedServerProfile> {
  const [row] = await db
    .select()
    .from(serverProfile)
    .where(eq(serverProfile.id, SERVER_PROFILE_ID))
    .limit(1);
  return resolveServerProfile(row ?? null, opts);
}

export async function upsertServerProfile(
  db: ServerProfileDb,
  patch: ServerProfilePatch,
  opts?: ResolveServerProfileOpts,
): Promise<ResolvedServerProfile> {
  const now = new Date();
  const insertValues: NewServerProfileRow = {
    id: SERVER_PROFILE_ID,
    updatedAt: now,
    ...patch,
  };

  const set: Partial<NewServerProfileRow> = { updatedAt: now };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.descriptionVisibility !== undefined) {
    set.descriptionVisibility = patch.descriptionVisibility;
  }
  if (patch.icon !== undefined) set.icon = patch.icon;
  if (patch.reviewedAt !== undefined) set.reviewedAt = patch.reviewedAt;

  const [row] = await db
    .insert(serverProfile)
    .values(insertValues)
    .onConflictDoUpdate({
      target: serverProfile.id,
      set,
    })
    .returning();

  return resolveServerProfile(row ?? null, opts);
}

/**
 * Persist a non-legacy server icon exactly once.
 *
 * The conditional conflict update is the concurrency boundary: after one
 * caller stores a canonical preset, later materializers cannot reroll it or
 * overwrite a concurrent Admin/upload choice.
 */
export async function materializeDefaultServerProfileOnce(
  db: ServerProfileDb,
  opts?: MaterializeDefaultServerProfileOpts,
): Promise<ResolvedServerProfile> {
  const chooseIndex = opts?.randomIndex ?? randomInt;
  const chosenId = SERVER_ICON_PRESET_IDS[chooseIndex(SERVER_ICON_PRESET_IDS.length)];
  if (!chosenId) {
    throw new RangeError("Server icon preset random index was out of range");
  }

  const now = new Date();
  const chosenIcon = { kind: "preset", id: chosenId } as const satisfies AvatarRef;
  const [materialized] = await db
    .insert(serverProfile)
    .values({
      id: SERVER_PROFILE_ID,
      icon: chosenIcon,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: serverProfile.id,
      set: { icon: chosenIcon, updatedAt: now },
      setWhere: or(
        isNull(serverProfile.icon),
        eq(serverProfile.icon, DEFAULT_SERVER_ICON),
      )!,
    })
    .returning();

  if (materialized) {
    return resolveServerProfile(materialized, opts);
  }
  return getServerProfile(db, opts);
}
