-- PostgreSQL's ON DELETE cascade needs UPDATE privilege on the referencing
-- column while taking its internal key-share lock. The immutable row trigger
-- still rejects every attempted value change.
GRANT UPDATE(wake_job_id)
  ON TABLE public.protected_task_wake_continuation_receipts TO nautilo;
