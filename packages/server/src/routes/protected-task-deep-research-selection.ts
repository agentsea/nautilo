import { isDeepStrictEqual } from "node:util";
import { parseDeepResearchTaskMetadataValue, type DeepResearchModelPlan } from "@nautilo/agent";
import { sql, tasks, type SQL } from "@nautilo/db";
import {
  classifyProtectedTaskMetadataV1,
  parseTaskFundingBinding,
  PROTECTED_TASK_EXECUTION_OPAQUE_ID_MAX_UTF8_BYTES_V1,
  type TaskFundingBinding,
} from "@nautilo/types";

type FundingLane = "supervisor" | "research" | "summarization" | "compression" | "finalReport";
type FrozenModelPlan = Readonly<DeepResearchModelPlan>;
type FundingByLane = Readonly<Record<FundingLane, TaskFundingBinding>>;
type RevisionByLane = Readonly<Record<FundingLane, number>>;

type OperationalDeepResearch =
  | Readonly<{ version: 1; modelPlan: FrozenModelPlan; invokingModelId: string | null }>
  | Readonly<{
    version: 2;
    modelPlan: FrozenModelPlan;
    invokingModelId: string | null;
    preferenceRevisions: RevisionByLane;
    modelFunding: FundingByLane;
    tavilyFunding: TaskFundingBinding;
  }>;

export type ProtectedTaskDeepResearchSelection = Readonly<{
  deepResearch: OperationalDeepResearch;
}>;

function boundedOpaqueText(value: SQL): SQL {
  return sql`case when jsonb_typeof(${value}) = 'string'
    then octet_length(${value} #>> '{}'::text[]) between 1 and ${PROTECTED_TASK_EXECUTION_OPAQUE_ID_MAX_UTF8_BYTES_V1}
    else false end`;
}

function boundedModelText(value: SQL): SQL {
  return sql`case when ${boundedOpaqueText(value)}
    then btrim(${value} #>> '{}'::text[]) <> ''
    else false end`;
}

function safeNonnegativeInteger(value: SQL): SQL {
  return sql`case when jsonb_typeof(${value}) = 'number'
    then (${value} #>> '{}'::text[])::numeric = trunc((${value} #>> '{}'::text[])::numeric)
      and (${value} #>> '{}'::text[])::numeric between 0 and ${Number.MAX_SAFE_INTEGER}
    else false end`;
}

function safePositiveInteger(value: SQL): SQL {
  return sql`case when jsonb_typeof(${value}) = 'number'
    then (${value} #>> '{}'::text[])::numeric = trunc((${value} #>> '{}'::text[])::numeric)
      and (${value} #>> '{}'::text[])::numeric between 1 and ${Number.MAX_SAFE_INTEGER}
    else false end`;
}

function validFundingBinding(value: SQL): SQL {
  return sql`case when jsonb_typeof(${value}) = 'object' then case
    when ${value}->>'kind' = 'server'
      then ((${value}) - 'kind' - 'providerRoute') = '{}'::jsonb
        and jsonb_typeof(${value}->'providerRoute') = 'string'
        and ${value}->>'providerRoute' ~ '^[a-z][a-z0-9-]*$'
    when ${value}->>'kind' = 'personal'
      then ((${value}) - 'kind' - 'providerRoute' - 'credentialId' - 'credentialRevision') = '{}'::jsonb
        and jsonb_typeof(${value}->'providerRoute') = 'string'
        and ${value}->>'providerRoute' ~ '^[a-z][a-z0-9-]*$'
        and jsonb_typeof(${value}->'credentialId') = 'string'
        and ${value}->>'credentialId'
          ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        and ${safePositiveInteger(sql`${value}->'credentialRevision'`)}
    else false end
    else false end`;
}

function fundingBindingProjection(value: SQL): SQL {
  return sql`case when ${value}->>'kind' = 'server'
    then jsonb_build_object('kind', 'server', 'providerRoute', ${value}->>'providerRoute')
    else jsonb_build_object(
      'kind', 'personal',
      'providerRoute', ${value}->>'providerRoute',
      'credentialId', ${value}->>'credentialId',
      'credentialRevision', ${value}->'credentialRevision'
    ) end`;
}

/** Only closed Deep Research execution and funding facts may leave the product row. */
export function protectedTaskDeepResearchSelectionProjection() {
  const research = sql`${tasks.metadata}->'deepResearch'`;
  const plan = sql`${research}->'modelPlan'`;
  const revisions = sql`${research}->'preferenceRevisions'`;
  const funding = sql`${research}->'modelFunding'`;
  const modelPlanValid = sql`case when jsonb_typeof(${plan}) = 'object' then
    ((${plan}) - 'version' - 'supervisorModel' - 'researchModel' - 'summarizationModel'
      - 'compressionModel' - 'finalReportModel') = '{}'::jsonb
    and ${plan}->'version' = '1'::jsonb
    and ${boundedModelText(sql`${plan}->'supervisorModel'`)}
    and ${boundedModelText(sql`${plan}->'researchModel'`)}
    and ${boundedModelText(sql`${plan}->'summarizationModel'`)}
    and ${boundedModelText(sql`${plan}->'compressionModel'`)}
    and ${boundedModelText(sql`${plan}->'finalReportModel'`)}
    else false end`;
  const revisionsValid = sql`case when jsonb_typeof(${revisions}) = 'object' then
    ((${revisions}) - 'supervisor' - 'research' - 'summarization' - 'compression' - 'finalReport') = '{}'::jsonb
    and ${safeNonnegativeInteger(sql`${revisions}->'supervisor'`)}
    and ${safeNonnegativeInteger(sql`${revisions}->'research'`)}
    and ${safeNonnegativeInteger(sql`${revisions}->'summarization'`)}
    and ${safeNonnegativeInteger(sql`${revisions}->'compression'`)}
    and ${safeNonnegativeInteger(sql`${revisions}->'finalReport'`)}
    else false end`;
  const fundingValid = sql`case when jsonb_typeof(${funding}) = 'object' then
    ((${funding}) - 'supervisor' - 'research' - 'summarization' - 'compression' - 'finalReport') = '{}'::jsonb
    and ${validFundingBinding(sql`${funding}->'supervisor'`)}
    and ${validFundingBinding(sql`${funding}->'research'`)}
    and ${validFundingBinding(sql`${funding}->'summarization'`)}
    and ${validFundingBinding(sql`${funding}->'compression'`)}
    and ${validFundingBinding(sql`${funding}->'finalReport'`)}
    else false end`;
  const modelPlanProjection = sql`jsonb_build_object(
    'version', 1,
    'supervisorModel', ${plan}->>'supervisorModel',
    'researchModel', ${plan}->>'researchModel',
    'summarizationModel', ${plan}->>'summarizationModel',
    'compressionModel', ${plan}->>'compressionModel',
    'finalReportModel', ${plan}->>'finalReportModel'
  )`;
  const fundingProjection = sql`jsonb_build_object(
    'supervisor', ${fundingBindingProjection(sql`${funding}->'supervisor'`)},
    'research', ${fundingBindingProjection(sql`${funding}->'research'`)},
    'summarization', ${fundingBindingProjection(sql`${funding}->'summarization'`)},
    'compression', ${fundingBindingProjection(sql`${funding}->'compression'`)},
    'finalReport', ${fundingBindingProjection(sql`${funding}->'finalReport'`)}
  )`;
  return sql<unknown>`case when jsonb_typeof(${tasks.metadata}) = 'object' then case
    when (${tasks.metadata} - 'deepResearch' - 'preparation' - 'lastInterruption') = '{}'::jsonb
      and jsonb_typeof(${research}) = 'object'
      and ${tasks.preset} in ('task', 'in_scope', 'in_private_namespace', 'in_background', 'schedule')
    then case
      when ((${research}) - 'version' - 'reportLanguage' - 'modelPlan' - 'invokingModelId') = '{}'::jsonb
        and ${research}->'version' = '1'::jsonb
        and (not (${research} ? 'reportLanguage')
          or jsonb_typeof(${research}->'reportLanguage') = 'string'
            and ${research}->>'reportLanguage' <> '')
        and ${modelPlanValid}
        and (jsonb_typeof(${research}->'invokingModelId') = 'null'
          or ${boundedOpaqueText(sql`${research}->'invokingModelId'`)})
      then jsonb_build_object('deepResearch', jsonb_build_object(
        'version', 1,
        'modelPlan', ${modelPlanProjection},
        'invokingModelId', ${research}->'invokingModelId'
      ))
      when ((${research}) - 'version' - 'reportLanguage' - 'modelPlan' - 'invokingModelId'
          - 'preferenceRevisions' - 'modelFunding' - 'tavilyFunding') = '{}'::jsonb
        and ${research}->'version' = '2'::jsonb
        and (not (${research} ? 'reportLanguage')
          or jsonb_typeof(${research}->'reportLanguage') = 'string'
            and ${research}->>'reportLanguage' <> '')
        and ${modelPlanValid}
        and (jsonb_typeof(${research}->'invokingModelId') = 'null'
          or ${boundedOpaqueText(sql`${research}->'invokingModelId'`)})
        and ${revisionsValid}
        and ${fundingValid}
        and ${validFundingBinding(sql`${research}->'tavilyFunding'`)}
      then jsonb_build_object('deepResearch', jsonb_build_object(
        'version', 2,
        'modelPlan', ${modelPlanProjection},
        'invokingModelId', ${research}->'invokingModelId',
        'preferenceRevisions', jsonb_build_object(
          'supervisor', ${revisions}->'supervisor',
          'research', ${revisions}->'research',
          'summarization', ${revisions}->'summarization',
          'compression', ${revisions}->'compression',
          'finalReport', ${revisions}->'finalReport'
        ),
        'modelFunding', ${fundingProjection},
        'tavilyFunding', ${fundingBindingProjection(sql`${research}->'tavilyFunding'`)}
      ))
      else null end
    else null end
  else null end`.as("deep_research_execution_selection");
}

function copyFunding(binding: TaskFundingBinding): TaskFundingBinding {
  return parseTaskFundingBinding({ ...binding });
}

function copyModelPlan(plan: DeepResearchModelPlan): FrozenModelPlan {
  return Object.freeze({ ...plan });
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  return (prototype === Object.prototype || prototype === null)
    && Reflect.ownKeys(value).length === Object.keys(value).length;
}

export function parseProtectedTaskDeepResearchSelection(value: unknown): ProtectedTaskDeepResearchSelection | null {
  if (!plainRecord(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, "deepResearch")) return null;
  const deepResearch = value["deepResearch"];
  if (!plainRecord(deepResearch)) return null;
  const injected = { ...deepResearch, reportLanguage: "und" };
  const classified = classifyProtectedTaskMetadataV1({ deepResearch: injected });
  if (classified.status !== "supported"
    || !isDeepStrictEqual(classified.operational, value)
    || !isDeepStrictEqual(classified.protectedContent, { deepResearch: { reportLanguage: "und" } })) return null;
  try {
    const parsed = parseDeepResearchTaskMetadataValue(injected);
    if (parsed.version === 1) {
      return Object.freeze({ deepResearch: Object.freeze({
        version: 1,
        modelPlan: copyModelPlan(parsed.modelPlan),
        invokingModelId: parsed.invokingModelId,
      }) });
    }
    const preferenceRevisions = Object.freeze({ ...parsed.preferenceRevisions });
    const modelFunding = Object.freeze({
      supervisor: copyFunding(parsed.modelFunding.supervisor),
      research: copyFunding(parsed.modelFunding.research),
      summarization: copyFunding(parsed.modelFunding.summarization),
      compression: copyFunding(parsed.modelFunding.compression),
      finalReport: copyFunding(parsed.modelFunding.finalReport),
    });
    return Object.freeze({ deepResearch: Object.freeze({
      version: 2,
      modelPlan: copyModelPlan(parsed.modelPlan),
      invokingModelId: parsed.invokingModelId,
      preferenceRevisions,
      modelFunding,
      tavilyFunding: copyFunding(parsed.tavilyFunding),
    }) });
  } catch {
    return null;
  }
}

export function sameProtectedTaskDeepResearchSelection(
  left: ProtectedTaskDeepResearchSelection | null | undefined,
  right: ProtectedTaskDeepResearchSelection,
): boolean {
  return left !== null && left !== undefined && isDeepStrictEqual(left, right);
}
