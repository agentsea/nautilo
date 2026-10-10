ALTER TABLE "connected_web_action_operations" ADD COLUMN "run_cost_custody" jsonb;--> statement-breakpoint
ALTER TABLE "connected_web_action_operations" ADD CONSTRAINT "connected_web_action_operations_run_cost_shape" CHECK (
      "connected_web_action_operations"."run_cost_custody" is null or ((
        jsonb_typeof("connected_web_action_operations"."run_cost_custody") = 'object'
        and "connected_web_action_operations"."run_cost_custody" ?& array['version', 'phase', 'hostedRun', 'browserSession', 'attribution']
        and "connected_web_action_operations"."run_cost_custody" - 'version' - 'phase' - 'hostedRun' - 'browserSession' - 'attribution' = '{}'::jsonb
        and jsonb_typeof("connected_web_action_operations"."run_cost_custody"->'version') = 'number'
        and "connected_web_action_operations"."run_cost_custody"->>'version' = '1'
        and "connected_web_action_operations"."run_cost_custody"->>'phase' in ('writer', 'verifier', 'resume_precheck')
        and jsonb_typeof("connected_web_action_operations"."run_cost_custody"->'hostedRun') = 'object'
        and ("connected_web_action_operations"."run_cost_custody"->'hostedRun') ?& array['identity', 'workload']
        and ("connected_web_action_operations"."run_cost_custody"->'hostedRun') - 'identity' - 'workload' = '{}'::jsonb
        and jsonb_typeof("connected_web_action_operations"."run_cost_custody"->'hostedRun'->'identity') = 'string'
        and jsonb_typeof("connected_web_action_operations"."run_cost_custody"->'hostedRun'->'workload') = 'string'
        and "connected_web_action_operations"."run_cost_custody"->'hostedRun'->>'workload' = 'connected_web_action'
        and octet_length("connected_web_action_operations"."run_cost_custody"->'hostedRun'->>'identity') between 1 and 512
        and jsonb_typeof("connected_web_action_operations"."run_cost_custody"->'browserSession') = 'object'
        and ("connected_web_action_operations"."run_cost_custody"->'browserSession') ?& array['identity', 'workload']
        and ("connected_web_action_operations"."run_cost_custody"->'browserSession') - 'identity' - 'workload' = '{}'::jsonb
        and jsonb_typeof("connected_web_action_operations"."run_cost_custody"->'browserSession'->'identity') = 'string'
        and jsonb_typeof("connected_web_action_operations"."run_cost_custody"->'browserSession'->'workload') = 'string'
        and "connected_web_action_operations"."run_cost_custody"->'browserSession'->>'workload' = 'connected_web_action'
        and octet_length("connected_web_action_operations"."run_cost_custody"->'browserSession'->>'identity') between 1 and 512
        and jsonb_typeof("connected_web_action_operations"."run_cost_custody"->'attribution') = 'object'
        and ("connected_web_action_operations"."run_cost_custody"->'attribution') ?& array['humanUserId', 'roomId', 'agentId']
        and ("connected_web_action_operations"."run_cost_custody"->'attribution') - 'humanUserId' - 'roomId' - 'agentId' = '{}'::jsonb
        and jsonb_typeof("connected_web_action_operations"."run_cost_custody"->'attribution'->'humanUserId') = 'string'
        and jsonb_typeof("connected_web_action_operations"."run_cost_custody"->'attribution'->'roomId') = 'string'
        and jsonb_typeof("connected_web_action_operations"."run_cost_custody"->'attribution'->'agentId') = 'string'
        and octet_length("connected_web_action_operations"."run_cost_custody"->'attribution'->>'humanUserId') between 1 and 512
        and octet_length("connected_web_action_operations"."run_cost_custody"->'attribution'->>'roomId') between 1 and 512
        and octet_length("connected_web_action_operations"."run_cost_custody"->'attribution'->>'agentId') between 1 and 512
      ) is true)
    );