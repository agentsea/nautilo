ALTER TABLE "connected_web_operations" DROP CONSTRAINT "connected_web_operations_terminal_read_result_shape";--> statement-breakpoint
ALTER TABLE "conversion_operations" ADD COLUMN "provider_sandbox" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "conversion_operations" ADD COLUMN "provider_region" varchar(32);--> statement-breakpoint
ALTER TABLE "conversion_operations" ADD COLUMN "max_output_bytes" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_web_operations" ADD CONSTRAINT "connected_web_operations_terminal_read_result_shape" CHECK (
      "connected_web_operations"."terminal_read_result" is null or (
        jsonb_typeof("connected_web_operations"."terminal_read_result") = 'object'
        and "connected_web_operations"."terminal_read_result"->>'version' = '1'
        and "connected_web_operations"."terminal_read_result" ?& array['version', 'account', 'page', 'read', 'cost', 'outputs', 'outputsTruncated']
        and "connected_web_operations"."terminal_read_result" - 'version' - 'account' - 'page' - 'read' - 'cost' - 'outputs' - 'outputsTruncated' = '{}'::jsonb
        and (("connected_web_operations"."account_id" is null and jsonb_typeof("connected_web_operations"."terminal_read_result"->'account') = 'null') or ("connected_web_operations"."account_id" is not null and jsonb_typeof("connected_web_operations"."terminal_read_result"->'account') = 'object'))
        and jsonb_typeof("connected_web_operations"."terminal_read_result"->'page') = 'object'
        and jsonb_typeof("connected_web_operations"."terminal_read_result"->'read') in ('null', 'object')
        and jsonb_typeof("connected_web_operations"."terminal_read_result"->'cost') = 'object'
        and jsonb_typeof("connected_web_operations"."terminal_read_result"->'outputs') = 'array'
        and jsonb_array_length("connected_web_operations"."terminal_read_result"->'outputs') <= 4
        and jsonb_typeof("connected_web_operations"."terminal_read_result"->'outputsTruncated') = 'boolean'
      )
    );--> statement-breakpoint
ALTER TABLE "conversion_operations" ADD CONSTRAINT "conversion_operations_max_output_bytes_positive" CHECK ("conversion_operations"."max_output_bytes" > 0);