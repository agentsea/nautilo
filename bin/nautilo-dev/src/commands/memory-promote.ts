/**
 * D324 — operator tool to list and promote archived memories (tier 2/3) back to tier 1.
 *
 * Dry-run by default; `--apply` writes. Uses direct SQL (not `promoteMemory`, which
 * only handles tier 2→1 in the agent store).
 *
 * Operator runbook:
 *   bun run dev:memory-promote -- --top 20          # dry-run: list top 20 archived
 *   bun run dev:memory-promote -- --id <uuid> --apply
 *   bun run dev:memory-promote -- --query "foo" --apply
 *   bun run dev:memory-promote -- --top 5 --apply
 */
import {
  and,
  createDirectDb,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  memories,
} from "@nautilo/db";
import { loadConfigEnvIntoProcess } from "../lib/config-env";
import { resolveAndEvaluateDefaultInstanceMutationGuard } from "../lib/default-instance-guard";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx === args.length - 1) return undefined;
  return args[idx + 1];
}

export function truncateContent(content: string | null, max = 72): string {
  if (content === null) return "[Protected content: ordinary representation unavailable]";
  const trimmed = content.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

export async function memoryPromoteCmd(args: string[]): Promise<number> {
  const apply = hasFlag(args, "--apply");
  const guard = resolveAndEvaluateDefaultInstanceMutationGuard({
    commandName: "dev:memory-promote",
    cwd: process.cwd(),
    isDryRunOrReadOnly: !apply,
    ...(hasFlag(args, "--i-know-what-i-am-doing") ? { iKnowWhatIAmDoing: true } : {}),
  });
  if (!guard.allowed) {
    console.error(guard.message);
    return 2;
  }

  loadConfigEnvIntoProcess({ path: flagValue(args, "--config-env") });

  const id = flagValue(args, "--id")?.trim();
  const query = flagValue(args, "--query");
  const topRaw = flagValue(args, "--top");

  if (id && query) {
    console.error("memory-promote: pass only one of --id or --query");
    return 2;
  }

  if (id && !UUID_RE.test(id)) {
    console.error("memory-promote: --id must be a UUID");
    return 2;
  }

  let top: number | undefined;
  if (topRaw !== undefined) {
    top = Number(topRaw);
    if (!Number.isInteger(top) || top <= 0) {
      console.error("memory-promote: --top must be a positive integer");
      return 2;
    }
  }

  const limit = id ? 1 : (top ?? 20);

  const db = createDirectDb(1);

  try {
    const where = id
      ? eq(memories.id, id)
      : query
        ? and(gte(memories.tier, 2), ilike(memories.content, `%${query}%`))
        : gte(memories.tier, 2);

    const rows = await db
      .select({
        id: memories.id,
        tier: memories.tier,
        type: memories.type,
        importance: memories.importance,
        content: memories.content,
        demotedAt: memories.demotedAt,
        demotedFrom: memories.demotedFrom,
        updatedAt: memories.updatedAt,
      })
      .from(memories)
      .where(where)
      .orderBy(desc(memories.importance), desc(memories.updatedAt))
      .limit(limit);

    if (rows.length === 0) {
      console.log("[memory-promote] No archived memories matched.");
      return 0;
    }

    const archived = rows.filter((r) => r.tier >= 2);
    if (archived.length === 0) {
      console.log("[memory-promote] Matched memory is already tier 1 (not archived).");
      for (const r of rows) {
        console.log(`  tier ${r.tier} · imp ${r.importance.toFixed(2)} · ${r.id}`);
        console.log(`    ${truncateContent(r.content)}`);
      }
      return 0;
    }

    console.log(
      `[memory-promote] ${apply ? "APPLY" : "DRY-RUN"} — ${archived.length} archived memor${archived.length === 1 ? "y" : "ies"}:`,
    );
    for (const r of archived) {
      const demoted =
        r.demotedAt != null
          ? ` · demoted from tier ${r.demotedFrom ?? "?"}`
          : "";
      console.log(`  tier ${r.tier} · imp ${r.importance.toFixed(2)} · ${r.type} · ${r.id}${demoted}`);
      console.log(`    ${truncateContent(r.content)}`);
    }

    if (!apply) {
      console.log("");
      console.log("[memory-promote] DRY-RUN — no rows changed. Re-run with --apply to promote.");
      return 0;
    }

    const ids = archived.map((r) => r.id);
    const promoted = await db
      .update(memories)
      .set({
        tier: 1,
        demotedAt: null,
        demotedFrom: null,
        updatedAt: new Date(),
      })
      .where(and(inArray(memories.id, ids), gte(memories.tier, 2)))
      .returning({ id: memories.id });

    console.log("");
    console.log(`[memory-promote] APPLIED — promoted ${promoted.length} memor${promoted.length === 1 ? "y" : "ies"} to tier 1.`);
    return 0;
  } finally {
    await db.end();
  }
}
