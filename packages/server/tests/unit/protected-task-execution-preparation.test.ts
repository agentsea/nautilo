import { describe, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import { getTableName, type SQL } from "drizzle-orm";
import { tasks, type DirectDatabase } from "@nautilo/db";
import { createProtectedTaskExecutionPreparation } from "../../src/routes/protected-task-execution-preparation";

type Input=Parameters<typeof createProtectedTaskExecutionPreparation>[0];
type Preparation=Parameters<Input["native"]>[0];
const execution={version:1,harnessId:"claude-code",source:"genie",profileRef:"profile",catalogModelId:"catalog",selectedModel:"model"};
const preparation={occurrence:{task:{id:"task",ownerId:"owner",requestorId:"requestor",agentId:"agent",contentRevision:2,
  cryptoObjectId:"definition",contentNamespaceId:"private-namespace",contentRepresentation:"protected",cryptoAccessRevision:1},run:{id:"run"}},
  policy:{mode:"encrypted_only",shadowBehavior:"strict",revision:4}} as Preparation;
function fixture(rows:readonly {native:boolean;claude:unknown;codex?:unknown;hermes?:unknown;opencode?:unknown;deepResearch?:unknown;repoDocs?:unknown}[], externalEnabled=true){
  const dialect=new PgDialect();const queries:{sql:string;params:unknown[]}[]=[];const calls:unknown[]=[];
  const db={select:(fields:Record<string,SQL|SQL.Aliased>)=>({from:(table:typeof tasks)=>({where:(condition:SQL)=>({limit:async(limit:number)=>{
    expect(getTableName(table)).toBe("tasks");expect(limit).toBe(2);
    for(const value of Object.values(fields))queries.push(dialect.sqlToQuery("sql" in value?value.sql:value));
    queries.push(dialect.sqlToQuery(condition));return rows;
  }})})})} as unknown as DirectDatabase;
  const result={} as Awaited<ReturnType<Input["native"]>>;
  const select=createProtectedTaskExecutionPreparation({db,native:async value=>{calls.push({kind:"native",value});return result;},
    claude:async(selection,value)=>{calls.push({kind:"claude",selection,value});return result;},
    ...(externalEnabled ? {
      codex:async(selection:Parameters<NonNullable<Input["codex"]>>[0],value:Preparation)=>{calls.push({kind:"codex",selection,value});return result;},
      opencode:async(selection:Parameters<NonNullable<Input["opencode"]>>[0],value:Preparation)=>{calls.push({kind:"opencode",selection,value});return result;},
      hermes:async(selection:Parameters<NonNullable<Input["hermes"]>>[0],value:Preparation)=>{calls.push({kind:"hermes",selection,value});return result;},
      deepResearch:async(selection:Parameters<NonNullable<Input["deepResearch"]>>[0],value:Preparation)=>{calls.push({kind:"deepResearch",selection,value});return result;},
      repoDocs:async(selection:Parameters<NonNullable<Input["repoDocs"]>>[0],value:Preparation)=>{calls.push({kind:"repoDocs",selection,value});return result;},
    } : {}) });
  return {select,calls,queries,result};
}
describe("protected Task execution preparation selection",()=>{
  test("native route preserves exact preparation without any provider selection",async()=>{
    const f=fixture([{native:true,claude:null}]);expect(await f.select(preparation)).toBe(f.result);
    expect(f.calls).toEqual([{kind:"native",value:preparation}]);
  });
  test("closed Claude route retains the exact encrypted preparation",async()=>{
    const f=fixture([{native:false,claude:execution}]);expect(await f.select(preparation)).toBe(f.result);
    expect(f.calls).toEqual([{kind:"claude",selection:{profileRef:"profile",catalogModelId:"catalog",selectedModel:"model"},value:preparation}]);
  });
  test("query binds immutable definition and requester coordinates before route selection",async()=>{
    const f=fixture([]);await rejects(f.select(preparation),/definition changed/u);
    const where=f.queries.at(-1)!;
    expect(where.params).toEqual(["task","owner","requestor","agent",2,"definition","private-namespace","verified"]);
    for(const column of ["id","owner_id","requestor_id","agent_id","content_revision","crypto_object_id","content_namespace_id","crypto_mapping_state"])
      expect(where.sql).toContain(`"tasks"."${column}" =`);
    expect(f.calls).toEqual([]);
  });
  test("malformed, ambiguous and unsupported providers never reach preparation",async()=>{
    for(const rows of [[],[{native:false,claude:execution},{native:false,claude:execution}],
      ...[null,[],"provider",{...execution,harnessId:"codex"},{...execution,workingDirectory:"/secret"},
        {...execution,source:"user"},{...execution,version:2},{...execution,profileRef:""}].map(claude=>[{native:false,claude}])]){
      const f=fixture(rows);await rejects(f.select(preparation));expect(f.calls).toEqual([]);
    }
  });
  test("generated projections use CASE before subtracting fields from scalar JSON metadata",async()=>{
    const f=fixture([{native:true,claude:null}]);await f.select(preparation);
    expect(f.queries[0]?.sql).toMatch(/case when jsonb_typeof\("tasks"\."metadata"\) = 'object' then/u);
    expect(f.queries[0]?.sql).toContain("else false end");
    expect(f.queries[1]?.sql).toContain("when jsonb_typeof(\"tasks\".\"metadata\") = 'object'");
    expect(f.queries[1]?.sql).toContain("jsonb_typeof(\"tasks\".\"metadata\"->'execution') = 'object'");
    expect(f.queries[1]?.sql).toContain("then case");
    expect(f.queries[1]?.sql).not.toContain("prompt");
  });
});

const codexSelection = { execution: { version: 1, harnessId: "codex", source: "genie", collaborationMode: "work",
  harnessModelId: "model", readiness: { relayId: "relay", pairingGenerationRef: "pairing", capabilityRevision: 4 } } };
const hermesSelection = { execution: { version: 1, harnessId: "hermes-acp", source: "genie",
  readiness: { relayId: "relay", relaySessionId: "socket", pairingGenerationRef: "pairing", desktopSessionId: "desktop",
    selectedProtocolVersion: 14, capabilityRevision: 4 } } };
for (const [kind, selection] of [["codex", codexSelection], ["hermes", hermesSelection]] as const) {
  test(`closed ${kind} routing retains the exact encrypted preparation`, async () => {
    const f = fixture([{ native: false, claude: null, [kind]: selection }]);
    expect(await f.select(preparation)).toBe(f.result);
    expect(f.calls).toEqual([{ kind, selection, value: preparation }]);
  });
  test(`${kind} without an installed protected adapter refuses before preparing any grant`, async () => {
    const f = fixture([{ native: false, claude: null, [kind]: selection }], false);
    await rejects(f.select(preparation), /route is unavailable/u); expect(f.calls).toEqual([]);
  });
}
test("Codex directory content and unsupported OpenCode cannot masquerade as operational selection", async () => {
  for (const selection of [{ execution: { ...codexSelection.execution, workingDirectory: "/private" } },
    { execution: { ...codexSelection.execution, harnessId: "opencode-acp" } },
    { execution: { ...hermesSelection.execution, harnessId: "opencode-acp" } }]) {
    const f = fixture([{ native: false, claude: null, codex: selection, hermes: selection }]);
    await rejects(f.select(preparation), /route is unavailable/u); expect(f.calls).toEqual([]);
  }
});

const deepResearchSelection = { deepResearch: { version: 1, invokingModelId: null,
  modelPlan: { version: 1, supervisorModel: "openai:supervisor", researchModel: "openai:research",
    summarizationModel: "openai:summary", compressionModel: "openai:compression", finalReportModel: "openai:report" } } };
test("closed research routing preserves the current preparation and never selects native execution", async () => {
  const f = fixture([{ native: false, claude: null, deepResearch: deepResearchSelection }]);
  expect(await f.select(preparation)).toBe(f.result);
  expect(f.calls).toEqual([{ kind: "deepResearch", selection: deepResearchSelection, value: preparation }]);
});
test("missing research adapter and leaked language refuse before grant preparation", async () => {
  for (const [selection, enabled] of [[deepResearchSelection, false],
    [{ deepResearch: { ...deepResearchSelection.deepResearch, reportLanguage: "private language" } }, true]] as const) {
    const f = fixture([{ native: false, claude: null, deepResearch: selection }], enabled);
    await rejects(f.select(preparation), /route is unavailable/u);
    expect(f.calls).toEqual([]);
  }
});

test("closed repo docs routing retains only mode and publication level", async () => {
  const selection = { mode: "update", publish: "pr" } as const;
  const f = fixture([{ native: false, claude: null, repoDocs: selection }]);
  expect(await f.select(preparation)).toBe(f.result);
  expect(f.calls).toEqual([{ kind: "repoDocs", selection, value: preparation }]);
  expect(f.queries.some(query => query.sql.includes("'target' - 'instructions'"))).toBe(true);
});

const openCodeSelection = { execution: { version: 1, harnessId: "opencode-acp", source: "genie", executionProfile: "autonomous",
  readiness: { ...hermesSelection.execution.readiness, selectedProtocolVersion: 15 } } };
test("existing autonomous OpenCode definitions use only the installed protected route", async () => {
  const f = fixture([{ native: false, claude: null, opencode: openCodeSelection }]);
  expect(await f.select(preparation)).toBe(f.result);
  expect(f.calls).toEqual([{ kind: "opencode", selection: openCodeSelection, value: preparation }]);
  for (const profile of ["interactive", "plan", "unknown"]) {
    const denied = fixture([{ native: false, claude: null, opencode: { execution: { ...openCodeSelection.execution, executionProfile: profile } } }]);
    await rejects(denied.select(preparation), /route is unavailable/u);
    expect(denied.calls).toEqual([]);
  }
  const missing = fixture([{ native: false, claude: null, opencode: openCodeSelection }], false);
  await rejects(missing.select(preparation), /route is unavailable/u);
  expect(missing.calls).toEqual([]);
});
