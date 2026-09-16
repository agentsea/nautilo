-- M173 — widen rooms.kind CHECK to admit 'access'.
--
-- An `access` room is a non-conversational, humans-only membership container
-- that backs a Namespace for an exact human access set (memory access
-- bookkeeping). rooms.kind is a plain text column whose allowed values are
-- enforced by the hand-maintained rooms_kind_check; Drizzle's text({enum}) is
-- TS-only and emits no SQL CHECK, so `bun db:generate` will NOT produce this.
-- Mirror the 0075 shape and append 'access' to the FULL current list — every
-- existing value MUST be kept or the re-add fails against live rows.
ALTER TABLE "rooms" DROP CONSTRAINT IF EXISTS "rooms_kind_check";--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_kind_check" CHECK ("rooms"."kind" IN ('private','group','multi_agent','subthread','open','task','access'));
