import { sql } from "drizzle-orm";
import { tasks } from "@nautilo/db";
import { ACP_RELAY_MAX_OPAQUE_ID_BYTES, ACP_RELAY_PROTOCOL_VERSION } from "@nautilo/relay";
import { isDeepStrictEqual } from "node:util";
import { parseHermesAcpExecutionMetadata, type HermesAcpExecutionMetadata } from "../acp/task-execution";

export type ProtectedTaskHermesSelection = HermesAcpExecutionMetadata;

/** Only the server-authored operational receipt crosses this projection. */
export function protectedTaskHermesSelectionProjection() {
  return sql<unknown>`case when jsonb_typeof(${tasks.metadata}) = 'object' then case
    when (${tasks.metadata} - 'execution' - 'preparation' - 'lastInterruption') = '{}'::jsonb
      and jsonb_typeof(${tasks.metadata}->'execution') = 'object'
      and ${tasks.preset} in ('task', 'in_scope', 'in_private_namespace', 'in_background', 'schedule')
    then case when ((${tasks.metadata}->'execution') - 'version' - 'harnessId' - 'source' - 'readiness') = '{}'::jsonb
      and ${tasks.metadata}->'execution'->'version' = '1'::jsonb
      and jsonb_typeof(${tasks.metadata}->'execution'->'harnessId') = 'string'
      and ${tasks.metadata}->'execution'->>'harnessId' = 'hermes-acp'
      and jsonb_typeof(${tasks.metadata}->'execution'->'source') = 'string'
      and ${tasks.metadata}->'execution'->>'source' = 'genie'
      and case when jsonb_typeof(${tasks.metadata}->'execution'->'readiness') = 'object'
        then case when ((${tasks.metadata}->'execution'->'readiness')
            - 'relayId' - 'relaySessionId' - 'pairingGenerationRef' - 'desktopSessionId'
            - 'selectedProtocolVersion' - 'capabilityRevision') = '{}'::jsonb
          and case when jsonb_typeof(${tasks.metadata}->'execution'->'readiness'->'relayId') = 'string'
            then octet_length(${tasks.metadata}->'execution'->'readiness'->>'relayId') between 1 and ${ACP_RELAY_MAX_OPAQUE_ID_BYTES}
            else false end
          and case when jsonb_typeof(${tasks.metadata}->'execution'->'readiness'->'relaySessionId') = 'string'
            then octet_length(${tasks.metadata}->'execution'->'readiness'->>'relaySessionId') between 1 and ${ACP_RELAY_MAX_OPAQUE_ID_BYTES}
            else false end
          and case when jsonb_typeof(${tasks.metadata}->'execution'->'readiness'->'pairingGenerationRef') = 'string'
            then octet_length(${tasks.metadata}->'execution'->'readiness'->>'pairingGenerationRef') between 1 and ${ACP_RELAY_MAX_OPAQUE_ID_BYTES}
            else false end
          and case when jsonb_typeof(${tasks.metadata}->'execution'->'readiness'->'desktopSessionId') = 'string'
            then octet_length(${tasks.metadata}->'execution'->'readiness'->>'desktopSessionId') between 1 and ${ACP_RELAY_MAX_OPAQUE_ID_BYTES}
            else false end
          and case when jsonb_typeof(${tasks.metadata}->'execution'->'readiness'->'selectedProtocolVersion') = 'number'
            then (${tasks.metadata}->'execution'->'readiness'->>'selectedProtocolVersion')::numeric
                = trunc((${tasks.metadata}->'execution'->'readiness'->>'selectedProtocolVersion')::numeric)
              and (${tasks.metadata}->'execution'->'readiness'->>'selectedProtocolVersion')::numeric
                between ${ACP_RELAY_PROTOCOL_VERSION} and ${Number.MAX_SAFE_INTEGER}
            else false end
          and case when jsonb_typeof(${tasks.metadata}->'execution'->'readiness'->'capabilityRevision') = 'number'
            then (${tasks.metadata}->'execution'->'readiness'->>'capabilityRevision')::numeric
                = trunc((${tasks.metadata}->'execution'->'readiness'->>'capabilityRevision')::numeric)
              and (${tasks.metadata}->'execution'->'readiness'->>'capabilityRevision')::numeric
                between 0 and ${Number.MAX_SAFE_INTEGER}
            else false end
          then true else false end
        else false end
      then jsonb_build_object('execution', jsonb_build_object(
        'version', 1,
        'harnessId', 'hermes-acp',
        'source', 'genie',
        'readiness', jsonb_build_object(
          'relayId', ${tasks.metadata}->'execution'->'readiness'->>'relayId',
          'relaySessionId', ${tasks.metadata}->'execution'->'readiness'->>'relaySessionId',
          'pairingGenerationRef', ${tasks.metadata}->'execution'->'readiness'->>'pairingGenerationRef',
          'desktopSessionId', ${tasks.metadata}->'execution'->'readiness'->>'desktopSessionId',
          'selectedProtocolVersion', ${tasks.metadata}->'execution'->'readiness'->'selectedProtocolVersion',
          'capabilityRevision', ${tasks.metadata}->'execution'->'readiness'->'capabilityRevision'
        )
      )) else null end
    else null end else null end`.as("hermes_execution_selection");
}
export function parseProtectedTaskHermesSelection(value: unknown): ProtectedTaskHermesSelection | null {
  return parseHermesAcpExecutionMetadata(value);
}
export function sameProtectedTaskHermesSelection(
  left: ProtectedTaskHermesSelection | null | undefined,
  right: ProtectedTaskHermesSelection,
): boolean {
  return left !== null && left !== undefined && isDeepStrictEqual(left, right);
}
