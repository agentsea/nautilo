CREATE TABLE "artifact_state" (
	"namespace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"artifact_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_state_namespace_id_agent_id_artifact_id_key_pk" PRIMARY KEY("namespace_id","agent_id","artifact_id","key")
);
--> statement-breakpoint
ALTER TABLE "artifact_state" ADD CONSTRAINT "artifact_state_namespace_id_namespaces_id_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_state" ADD CONSTRAINT "artifact_state_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;