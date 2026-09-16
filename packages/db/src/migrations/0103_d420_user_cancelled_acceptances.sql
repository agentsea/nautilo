-- D420 (Wave 2 task 2.2.3 correction) — add `user_cancelled` as the minimal
-- truthful terminal acceptance status for D349 user-Stop-discarded queued and
-- buffered/coalesced acceptances. `maintenance_cancelled` continues to mean
-- maintenance drain only; the two outcomes must remain distinct (R8). This is
-- an ADDITIVE migration: it only widens the existing `work_acceptances_status_check`
-- constraint so legacy `accepted | dispatched | maintenance_cancelled` rows are
-- unaffected, and a user Stop can record `user_cancelled` without relabeling a
-- maintenance cancellation. The maintenance sweep filters on `status='accepted'`,
-- so `user_cancelled` (terminal) rows are left untouched.
ALTER TABLE "work_acceptances" DROP CONSTRAINT "work_acceptances_status_check";--> statement-breakpoint
ALTER TABLE "work_acceptances" ADD CONSTRAINT "work_acceptances_status_check" CHECK ("work_acceptances"."status" IN ('accepted', 'dispatched', 'user_cancelled', 'maintenance_cancelled'));
