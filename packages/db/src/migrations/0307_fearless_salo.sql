CREATE TABLE "protected_task_run_output_bindings" (
	"task_run_id" uuid PRIMARY KEY NOT NULL,
	"binding_id" text NOT NULL,
	"delivery_mode" text NOT NULL,
	"destination_room_id" uuid,
	"destination_namespace_id" uuid,
	"result_operation_id" text NOT NULL,
	"result_object_id" text NOT NULL,
	"message_operation_id" text,
	"wake_operation_id" text,
	"accepted_policy_revision" integer NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"result_terminal_at" timestamp with time zone,
	"result_attached_at" timestamp with time zone,
	"message_id" integer,
	"message_published_at" timestamp with time zone,
	"wake_job_id" uuid,
	"wake_scheduled_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "protected_task_run_output_bindings_binding_id_unique" UNIQUE("binding_id"),
	CONSTRAINT "protected_task_run_output_bindings_result_operation_id_unique" UNIQUE("result_operation_id"),
	CONSTRAINT "protected_task_run_output_bindings_result_object_id_unique" UNIQUE("result_object_id"),
	CONSTRAINT "protected_task_run_output_bindings_message_operation_id_unique" UNIQUE("message_operation_id"),
	CONSTRAINT "protected_task_run_output_bindings_wake_operation_id_unique" UNIQUE("wake_operation_id"),
	CONSTRAINT "protected_task_run_output_bindings_wake_job_id_unique" UNIQUE("wake_job_id"),
	CONSTRAINT "protected_task_run_output_bindings_policy_revision_positive" CHECK ("protected_task_run_output_bindings"."accepted_policy_revision" > 0),
	CONSTRAINT "protected_task_run_output_bindings_result_identity_shape" CHECK ("protected_task_run_output_bindings"."binding_id" = 'task-run-output:' || "protected_task_run_output_bindings"."task_run_id"::text
        and "protected_task_run_output_bindings"."result_operation_id" = 'task-run-result:' || "protected_task_run_output_bindings"."task_run_id"::text
        and "protected_task_run_output_bindings"."result_object_id" ~ '^task-run-result:v1:[0-9a-f]{64}$'),
	CONSTRAINT "protected_task_run_output_bindings_delivery_shape" CHECK ((
        "protected_task_run_output_bindings"."delivery_mode" = 'none'
        and "protected_task_run_output_bindings"."destination_room_id" is null
        and "protected_task_run_output_bindings"."destination_namespace_id" is null
        and "protected_task_run_output_bindings"."message_operation_id" is null
        and "protected_task_run_output_bindings"."wake_operation_id" is null
      ) or (
        "protected_task_run_output_bindings"."delivery_mode" = 'raw'
        and "protected_task_run_output_bindings"."destination_room_id" is not null
        and "protected_task_run_output_bindings"."destination_namespace_id" is not null
        and "protected_task_run_output_bindings"."message_operation_id" = 'task-run-delivery-message:' || "protected_task_run_output_bindings"."task_run_id"::text
        and "protected_task_run_output_bindings"."wake_operation_id" is null
      ) or (
        "protected_task_run_output_bindings"."delivery_mode" = 'wake'
        and "protected_task_run_output_bindings"."destination_room_id" is not null
        and "protected_task_run_output_bindings"."destination_namespace_id" is not null
        and "protected_task_run_output_bindings"."message_operation_id" is null
        and "protected_task_run_output_bindings"."wake_operation_id" = 'task-run-delivery-wake:' || "protected_task_run_output_bindings"."task_run_id"::text
      ) or (
        "protected_task_run_output_bindings"."delivery_mode" = 'raw_and_wake'
        and "protected_task_run_output_bindings"."destination_room_id" is not null
        and "protected_task_run_output_bindings"."destination_namespace_id" is not null
        and "protected_task_run_output_bindings"."message_operation_id" = 'task-run-delivery-message:' || "protected_task_run_output_bindings"."task_run_id"::text
        and "protected_task_run_output_bindings"."wake_operation_id" = 'task-run-delivery-wake:' || "protected_task_run_output_bindings"."task_run_id"::text
      )),
	CONSTRAINT "protected_task_run_output_bindings_message_receipt_coherent" CHECK (("protected_task_run_output_bindings"."message_id" is null) = ("protected_task_run_output_bindings"."message_published_at" is null)
        and ("protected_task_run_output_bindings"."message_id" is null or "protected_task_run_output_bindings"."message_operation_id" is not null)),
	CONSTRAINT "protected_task_run_output_bindings_wake_receipt_coherent" CHECK (("protected_task_run_output_bindings"."wake_job_id" is null) = ("protected_task_run_output_bindings"."wake_scheduled_at" is null)
        and ("protected_task_run_output_bindings"."wake_job_id" is null or "protected_task_run_output_bindings"."wake_operation_id" is not null)),
	CONSTRAINT "protected_task_run_output_bindings_result_receipt_coherent" CHECK ("protected_task_run_output_bindings"."result_attached_at" is null
        or ("protected_task_run_output_bindings"."result_terminal_at" is not null
          and "protected_task_run_output_bindings"."result_attached_at" >= "protected_task_run_output_bindings"."result_terminal_at")),
	CONSTRAINT "protected_task_run_output_bindings_completion_coherent" CHECK ("protected_task_run_output_bindings"."completed_at" is null or (
        "protected_task_run_output_bindings"."result_attached_at" is not null
        and ("protected_task_run_output_bindings"."message_operation_id" is null or "protected_task_run_output_bindings"."message_published_at" is not null)
        and ("protected_task_run_output_bindings"."wake_operation_id" is null or "protected_task_run_output_bindings"."wake_scheduled_at" is not null)
        and "protected_task_run_output_bindings"."completed_at" >= "protected_task_run_output_bindings"."accepted_at"
      ))
);
--> statement-breakpoint
ALTER TABLE "protected_task_run_output_bindings" ADD CONSTRAINT "protected_task_run_output_bindings_task_run_id_task_runs_id_fk" FOREIGN KEY ("task_run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protected_task_run_output_bindings" ADD CONSTRAINT "protected_task_run_output_bindings_destination_fk" FOREIGN KEY ("destination_room_id","destination_namespace_id") REFERENCES "public"."rooms"("id","namespace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_protected_task_run_output_bindings_recovery" ON "protected_task_run_output_bindings" USING btree ("completed_at","accepted_at","task_run_id");