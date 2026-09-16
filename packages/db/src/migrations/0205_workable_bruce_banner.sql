CREATE TABLE "human_blocks" (
	"blocker_user_id" uuid NOT NULL,
	"blocked_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "human_blocks_blocker_user_id_blocked_user_id_pk" PRIMARY KEY("blocker_user_id","blocked_user_id"),
	CONSTRAINT "human_blocks_no_self_check" CHECK ("human_blocks"."blocker_user_id" <> "human_blocks"."blocked_user_id")
);
--> statement-breakpoint
ALTER TABLE "human_blocks" ADD CONSTRAINT "human_blocks_blocker_user_id_users_id_fk" FOREIGN KEY ("blocker_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_blocks" ADD CONSTRAINT "human_blocks_blocked_user_id_users_id_fk" FOREIGN KEY ("blocked_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_human_blocks_blocked_user" ON "human_blocks" USING btree ("blocked_user_id");--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nautilo_agent') THEN
    REVOKE ALL ON TABLE public.human_blocks FROM nautilo_agent;
  END IF;
END $$;
