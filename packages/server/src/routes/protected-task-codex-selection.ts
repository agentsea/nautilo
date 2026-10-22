import { isDeepStrictEqual } from "node:util";
import { sql, tasks } from "@nautilo/db";
import { CODEX_RELAY_MAX_OPAQUE_ID_BYTES } from "@nautilo/relay";
import { classifyProtectedTaskMetadataV1 } from "@nautilo/types";
import { isCodexHarnessExecutionMetadata } from "../codex/harness-admission";
import { parseCodexModelOutputContract, type CodexModelOutputContract } from "../codex/model-output-contract";

export type ProtectedTaskCodexSelection = Readonly<{
  execution: Readonly<{
    version: 1;
    harnessId: "codex";
    source: "genie";
    collaborationMode: "work" | "plan";
    harnessModelId: string;
    readiness: Readonly<{ relayId: string; pairingGenerationRef: string; capabilityRevision: number }>;
    outputContract?: CodexModelOutputContract;
  }>;
}>;

/** Shadow may retain a directory sibling; it never leaves this operational projection. */
export function protectedTaskCodexSelectionProjection() {
  return sql<unknown>`case
    when jsonb_typeof(${tasks.metadata}) = 'object'
    then case
      when (${tasks.metadata} - 'execution' - 'preparation' - 'lastInterruption') = '{}'::jsonb
        and jsonb_typeof(${tasks.metadata}->'execution') = 'object'
        and ${tasks.preset} in ('task', 'in_scope', 'in_private_namespace', 'in_background', 'schedule')
      then case
        when ((${tasks.metadata}->'execution') - 'version' - 'harnessId' - 'source'
          - 'collaborationMode' - 'harnessModelId' - 'outputContract' - 'readiness' - 'workingDirectory') = '{}'::jsonb
          and ${tasks.metadata}->'execution'->'version' = '1'::jsonb
          and jsonb_typeof(${tasks.metadata}->'execution'->'harnessId') = 'string'
          and ${tasks.metadata}->'execution'->>'harnessId' = 'codex'
          and jsonb_typeof(${tasks.metadata}->'execution'->'source') = 'string'
          and ${tasks.metadata}->'execution'->>'source' = 'genie'
          and jsonb_typeof(${tasks.metadata}->'execution'->'collaborationMode') = 'string'
          and ${tasks.metadata}->'execution'->>'collaborationMode' in ('work', 'plan')
          and case when jsonb_typeof(${tasks.metadata}->'execution'->'harnessModelId') = 'string'
            then octet_length(${tasks.metadata}->'execution'->>'harnessModelId') between 1 and ${CODEX_RELAY_MAX_OPAQUE_ID_BYTES}
            else false end
          and case when jsonb_typeof(${tasks.metadata}->'execution'->'readiness') = 'object'
            then case when ((${tasks.metadata}->'execution'->'readiness')
                - 'relayId' - 'pairingGenerationRef' - 'capabilityRevision') = '{}'::jsonb
              and case when jsonb_typeof(${tasks.metadata}->'execution'->'readiness'->'relayId') = 'string'
                then octet_length(${tasks.metadata}->'execution'->'readiness'->>'relayId') between 1 and ${CODEX_RELAY_MAX_OPAQUE_ID_BYTES}
                else false end
              and case when jsonb_typeof(${tasks.metadata}->'execution'->'readiness'->'pairingGenerationRef') = 'string'
                then octet_length(${tasks.metadata}->'execution'->'readiness'->>'pairingGenerationRef') between 1 and ${CODEX_RELAY_MAX_OPAQUE_ID_BYTES}
                else false end
              and case when jsonb_typeof(${tasks.metadata}->'execution'->'readiness'->'capabilityRevision') = 'number'
                then (${tasks.metadata}->'execution'->'readiness'->>'capabilityRevision')::numeric
                    = trunc((${tasks.metadata}->'execution'->'readiness'->>'capabilityRevision')::numeric)
                  and (${tasks.metadata}->'execution'->'readiness'->>'capabilityRevision')::numeric
                    between 0 and ${Number.MAX_SAFE_INTEGER}
                else false end
              then true else false end
            else false end
          and case when not (${tasks.metadata}->'execution' ? 'outputContract') then true
            when jsonb_typeof(${tasks.metadata}->'execution'->'outputContract') = 'object'
            then case when ((${tasks.metadata}->'execution'->'outputContract')
                - 'version' - 'capabilityModelId' - 'catalogVersion' - 'contextTokens' - 'outputTokens') = '{}'::jsonb
              and ${tasks.metadata}->'execution'->'outputContract'->'version' = '1'::jsonb
              and case when jsonb_typeof(${tasks.metadata}->'execution'->'outputContract'->'capabilityModelId') = 'string'
                then ${tasks.metadata}->'execution'->'outputContract'->>'capabilityModelId'
                  ~ '^openai:[A-Za-z0-9][A-Za-z0-9._-]{0,255}$'
                else false end
              and case when jsonb_typeof(${tasks.metadata}->'execution'->'outputContract'->'catalogVersion') = 'string'
                then octet_length(${tasks.metadata}->'execution'->'outputContract'->>'catalogVersion') between 1 and ${CODEX_RELAY_MAX_OPAQUE_ID_BYTES}
                else false end
              and case when jsonb_typeof(${tasks.metadata}->'execution'->'outputContract'->'contextTokens') = 'number'
                then (${tasks.metadata}->'execution'->'outputContract'->>'contextTokens')::numeric
                    = trunc((${tasks.metadata}->'execution'->'outputContract'->>'contextTokens')::numeric)
                  and (${tasks.metadata}->'execution'->'outputContract'->>'contextTokens')::numeric
                    between 1 and ${Number.MAX_SAFE_INTEGER}
                else false end
              and case when jsonb_typeof(${tasks.metadata}->'execution'->'outputContract'->'outputTokens') = 'number'
                then (${tasks.metadata}->'execution'->'outputContract'->>'outputTokens')::numeric
                    = trunc((${tasks.metadata}->'execution'->'outputContract'->>'outputTokens')::numeric)
                  and (${tasks.metadata}->'execution'->'outputContract'->>'outputTokens')::numeric
                    between 1 and ${Number.MAX_SAFE_INTEGER}
                else false end
              and case when jsonb_typeof(${tasks.metadata}->'execution'->'outputContract'->'outputTokens') = 'number'
                  and jsonb_typeof(${tasks.metadata}->'execution'->'outputContract'->'contextTokens') = 'number'
                then (${tasks.metadata}->'execution'->'outputContract'->>'outputTokens')::numeric
                  <= (${tasks.metadata}->'execution'->'outputContract'->>'contextTokens')::numeric
                else false end
              then true else false end
            else false end
        then jsonb_build_object('execution',
          jsonb_build_object(
            'version', 1,
            'harnessId', 'codex',
            'source', 'genie',
            'collaborationMode', ${tasks.metadata}->'execution'->>'collaborationMode',
            'harnessModelId', ${tasks.metadata}->'execution'->>'harnessModelId',
            'readiness', jsonb_build_object(
              'relayId', ${tasks.metadata}->'execution'->'readiness'->>'relayId',
              'pairingGenerationRef', ${tasks.metadata}->'execution'->'readiness'->>'pairingGenerationRef',
              'capabilityRevision', ${tasks.metadata}->'execution'->'readiness'->'capabilityRevision'
            )
          ) || case when ${tasks.metadata}->'execution' ? 'outputContract'
            then jsonb_build_object('outputContract', jsonb_build_object(
              'version', 1,
              'capabilityModelId', ${tasks.metadata}->'execution'->'outputContract'->>'capabilityModelId',
              'catalogVersion', ${tasks.metadata}->'execution'->'outputContract'->>'catalogVersion',
              'contextTokens', ${tasks.metadata}->'execution'->'outputContract'->'contextTokens',
              'outputTokens', ${tasks.metadata}->'execution'->'outputContract'->'outputTokens'
            ))
            else '{}'::jsonb end
        )
        else null
      end
      else null
    end
    else null
  end`.as("codex_execution_selection");
}

export function parseProtectedTaskCodexSelection(value: unknown): ProtectedTaskCodexSelection | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const metadata = value as Readonly<Record<string, unknown>>;
  if (!isCodexHarnessExecutionMetadata(metadata)) return null;
  const classified = classifyProtectedTaskMetadataV1(metadata);
  if (classified.status !== "supported" || Object.keys(classified.protectedContent).length !== 0
    || !isDeepStrictEqual(classified.operational, metadata)) return null;
  const execution = classified.operational["execution"];
  if (execution === null || typeof execution !== "object" || Array.isArray(execution)) return null;
  const fields = execution as Readonly<Record<string, unknown>>;
  const readiness = fields["readiness"];
  if (readiness === null || typeof readiness !== "object" || Array.isArray(readiness)) return null;
  const receipt = readiness as Readonly<Record<string, unknown>>;
  const collaborationMode = fields["collaborationMode"];
  const harnessModelId = fields["harnessModelId"];
  const relayId = receipt["relayId"];
  const pairingGenerationRef = receipt["pairingGenerationRef"];
  const capabilityRevision = receipt["capabilityRevision"];
  const outputContract = fields["outputContract"] === undefined ? undefined
    : parseCodexModelOutputContract(fields["outputContract"]);
  if ((collaborationMode !== "work" && collaborationMode !== "plan")
    || typeof harnessModelId !== "string" || typeof relayId !== "string"
    || typeof pairingGenerationRef !== "string" || typeof capabilityRevision !== "number"
    || new TextEncoder().encode(relayId).byteLength > CODEX_RELAY_MAX_OPAQUE_ID_BYTES
    || new TextEncoder().encode(pairingGenerationRef).byteLength > CODEX_RELAY_MAX_OPAQUE_ID_BYTES
    || outputContract === null) return null;
  return Object.freeze({ execution: Object.freeze({ version: 1, harnessId: "codex", source: "genie",
    collaborationMode, harnessModelId,
    readiness: Object.freeze({ relayId, pairingGenerationRef, capabilityRevision }),
    ...(outputContract === undefined ? {} : { outputContract: Object.freeze({ ...outputContract }) }),
  }) });
}

export function sameProtectedTaskCodexSelection(
  left: ProtectedTaskCodexSelection | null | undefined,
  right: ProtectedTaskCodexSelection,
): boolean {
  return left !== null && left !== undefined && isDeepStrictEqual(left, right);
}
