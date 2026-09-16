/**
 * M158 — one-time read baseline (D-2 / MR5).
 *
 * Kills "phantom historical unread": every pre-feature `main` message with
 * `read_at IS NULL` (scalar shape) or no `session_message_recipient_state`
 * read row (junction shape) otherwise counts as unread forever, so the
 * unread dot lights on launch for rooms the operator has already read. This
 * command stamps every currently-unread, display-eligible message as read so
 * the feature starts from "all caught up".
 *
 * Why a command, NOT a migration (operator contract, 2026-06-11): we already
 * carry too many Drizzle migrations and there are only a handful of databases
 * to care about, so the read baseline ships as a one-shot dev escape-hatch the
 * operator runs by hand rather than a journalled DB migration. Nothing is added
 * to the migration journal.
 *
 * Operator runbook (run by the OPERATOR, not the implementing agent):
 *   bun run dev:mark-all-messages-read              # dry-run: report row counts
 *   bun run dev:mark-all-messages-read -- --apply   # commit the baseline
 *
 * D202: guarded against the protected (default) instance. A mutating `--apply`
 * against `(default)` requires `--i-know-what-i-am-doing` (or
 * `ALLOW_DEFAULT_DB_MUTATION=1`). The dry-run is always allowed.
 *
 * Predicate note: we stamp ALL `main` `user`/`assistant` rows once (a blunt
 * baseline). That is acceptable because `queryUnreadCountsForRooms` also
 * excludes the viewer's own turns + task-originated rows at read time, so
 * over-stamping here can never make a real message appear unread.
 */
import { createDirectDb, sql } from "@nautilo/db";
import { loadConfigEnvIntoProcess } from "../lib/config-env";
import { resolveAndEvaluateDefaultInstanceMutationGuard } from "../lib/default-instance-guard";

export async function markAllMessagesRead(args: {
  apply?: boolean | undefined;
  configEnvPath?: string | undefined;
  iKnowWhatIAmDoing?: boolean | undefined;
}): Promise<number> {
  const guard = resolveAndEvaluateDefaultInstanceMutationGuard({
    commandName: "dev:mark-all-messages-read",
    cwd: process.cwd(),
    isDryRunOrReadOnly: args.apply !== true,
    ...(args.iKnowWhatIAmDoing === true ? { iKnowWhatIAmDoing: true } : {}),
  });
  if (!guard.allowed) {
    console.error(guard.message);
    return 2;
  }

  loadConfigEnvIntoProcess({ path: args.configEnvPath });

  const apply = args.apply === true;
  const db = createDirectDb(1);

  try {
    if (!apply) {
      // DRY-RUN: report how many rows the two --apply statements WOULD change.
      const scalarPreview = await db.execute(sql`
        SELECT count(*)::int AS n
        FROM session_messages sm
        WHERE sm.read_at IS NULL
          AND sm.transcript_origin IN ('main', 'subagent')
          AND sm.role IN ('user', 'assistant')
      `);
      const scalarN = Number(
        (scalarPreview as unknown as Array<{ n: number }>)[0]?.n ?? 0,
      );

      const junctionPreview = await db.execute(sql`
        SELECT count(*)::int AS n
        FROM session_messages sm
        JOIN sessions s ON s.id = sm.session_id
        JOIN room_members rm ON rm.room_id = s.room_id
        JOIN actors a ON a.id = rm.actor_id AND a.kind = 'user'
        LEFT JOIN session_message_recipient_state smrs
          ON smrs.message_id = sm.id AND smrs.recipient_id = a.owner_id
        WHERE sm.transcript_origin IN ('main', 'subagent')
          AND sm.role IN ('user', 'assistant')
          AND (smrs.read_at IS NULL)
      `);
      const junctionN = Number(
        (junctionPreview as unknown as Array<{ n: number }>)[0]?.n ?? 0,
      );

      console.log("[mark-read] DRY-RUN — read-baseline preview:");
      console.log(
        `[mark-read]   scalar UPDATE session_messages.read_at: ${scalarN} row(s) would be stamped`,
      );
      console.log(
        `[mark-read]   junction INSERT session_message_recipient_state: ${junctionN} (message, human-member) pair(s) would be newly stamped`,
      );
      console.log("");
      console.log(
        "[mark-read] DRY-RUN — no rows changed. Re-run with --apply to commit.",
      );
      return 0;
    }

    // APPLY: run BOTH statements inside ONE transaction so the baseline is atomic.
    await db.transaction(async (tx) => {
      const scalarRes = await tx.execute(sql`
        UPDATE session_messages sm
        SET read_at = NOW()
        WHERE sm.read_at IS NULL
          AND sm.transcript_origin IN ('main', 'subagent')
          AND sm.role IN ('user', 'assistant')
        RETURNING sm.id
      `);
      const scalarCount = (scalarRes as unknown as unknown[]).length;

      const junctionRes = await tx.execute(sql`
        INSERT INTO session_message_recipient_state (message_id, recipient_id, read_at)
        SELECT sm.id, a.owner_id, NOW()
        FROM session_messages sm
        JOIN sessions s ON s.id = sm.session_id
        JOIN room_members rm ON rm.room_id = s.room_id
        JOIN actors a ON a.id = rm.actor_id AND a.kind = 'user'
        WHERE sm.transcript_origin IN ('main', 'subagent')
          AND sm.role IN ('user', 'assistant')
        ON CONFLICT (message_id, recipient_id) DO UPDATE
          SET read_at = COALESCE(session_message_recipient_state.read_at, EXCLUDED.read_at)
        RETURNING message_id
      `);
      const junctionCount = (junctionRes as unknown as unknown[]).length;

      console.log(
        `[mark-read]   scalar UPDATE session_messages.read_at: ${scalarCount} row(s) stamped`,
      );
      console.log(
        `[mark-read]   junction upsert session_message_recipient_state: ${junctionCount} row(s) stamped`,
      );
    });

    console.log("");
    console.log("[mark-read] APPLIED — read baseline stamped.");
    return 0;
  } finally {
    await db.end();
  }
}
