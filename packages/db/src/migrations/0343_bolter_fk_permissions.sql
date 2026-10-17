-- Custom SQL migration file, put your code below! --
-- Bolter owner deletion and FK maintenance
GRANT SELECT(id,user_id,binding_id,session_message_id,job_id), UPDATE(id)
  ON TABLE public.bolter_inbox_receipts TO nautilo;--> statement-breakpoint
GRANT SELECT(user_id,binding_id,source_inbox_id,session_message_id), UPDATE(id)
  ON TABLE public.bolter_outbox TO nautilo;--> statement-breakpoint
GRANT UPDATE(id) ON TABLE public.bolter_room_bindings TO nautilo;--> statement-breakpoint
GRANT DELETE ON TABLE public.bolter_outbox, public.bolter_inbox_receipts,
  public.bolter_room_bindings, public.bolter_connections TO nautilo;--> statement-breakpoint
COMMENT ON TABLE public.bolter_connections IS 'Bolter owner deletion and FK maintenance';
