CREATE TABLE "soul_generation_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"human_user_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "soul_generation_attempts" ADD CONSTRAINT "soul_generation_attempts_human_user_id_users_id_fk" FOREIGN KEY ("human_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_soul_generation_attempts_human_time" ON "soul_generation_attempts" USING btree ("human_user_id","started_at");