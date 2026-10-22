import { describe, expect, test } from "bun:test";
import { deriveTaskContentCryptoObjectIdV1, type TaskPayloadV1 } from "@nautilo/lattice-bridge";
import { LatticeCrypto, authorizationRevision, createDomainForegroundAuthorizationPlan,
  cryptoDeviceId, humanId } from "@nautilo/lattice-crypto";
import { createTaskRuntimeBackgroundAuthorizationRequestV1,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1 } from "@nautilo/lattice-crypto/background";
import { ProtectedTaskExecutionDidNotBeginError, type BackgroundAuthorizationTaskRuntimeRecordV3,
  type HarnessExecutionOutput, type ProtectedTaskOccurrence, type ProtectedTaskPredispatchPlan,
  type ProtectedTaskRunningOccurrence, type TaskRuntimeGrantClaimPlan } from "@nautilo/runtime";
import { withTaskRuntimeExecutionEvidenceV1, type TaskRuntimeExecutionEvidenceInputV1 }
  from "../../../lattice-crypto/src/background/task-runtime-execution-evidence-v1";
import { createProtectedTaskClaudeExecution } from "../../src/routes/protected-task-claude-execution";
import type { ClaudeExecutionAdmission } from "../../src/claude/connection-controller";

const NOW = 2_230_000_000_000;
const USER = "10000000-0000-4000-8000-000000000001";
const HUMAN = "20000000-0000-4000-8000-000000000002";
const DEVICE = "30000000-0000-4000-8000-000000000003";
const AGENT = "40000000-0000-4000-8000-000000000004";
const TASK = "50000000-0000-4000-8000-000000000005";
const RUN = "60000000-0000-4000-8000-000000000006";
const JOB = "70000000-0000-4000-8000-000000000007";
const PAUSE_REQUEST = "71000000-0000-4000-8000-000000000007";
const ROOM = "80000000-0000-4000-8000-000000000008";
const NAMESPACE = "90000000-0000-4000-8000-000000000009";
const DOMAIN = "a0000000-0000-4000-8000-00000000000a";
const INPUT_OBJECT = deriveTaskContentCryptoObjectIdV1({kind:"definition",taskId:TASK,contentRevision:1});
const RESULT_OBJECT = deriveTaskContentCryptoObjectIdV1({kind:"run_result",taskId:TASK,taskRunId:RUN,contentRevision:1});
const REQUEST = `task-run-authorization:${RUN}`;
const bytes = (fill: number) => new Uint8Array(32).fill(fill);
const selection = { profileRef: "profile-1", catalogModelId: "claude-sonnet", selectedModel: "claude-sonnet-4" };
const scope = { relayId: "relay-1", relaySessionId: "socket-1", desktopSessionId: "desktop-1",
  pairingGenerationRef: "pairing-1", selectedProtocolVersion: 32, capabilityRevision: 3 };
const attribution = { taskId:TASK,bindingId:RUN,bindingGeneration:JOB,roomId:ROOM,
  vendorSessionId:"provider-session",vendorTurnId:"provider-turn",vendorItemId:"provider-item" };
const candidate: HarnessExecutionOutput = {kind:"assistant_completed",attribution,text:"protected answer"};
const completed: HarnessExecutionOutput = {kind:"terminal",attribution,status:"completed"};
type Input = Parameters<typeof createProtectedTaskClaudeExecution>[0];
type Dependencies = NonNullable<Parameters<typeof createProtectedTaskClaudeExecution>[1]>;
type Registration = Parameters<Input["requests"]["register"]>[0];

async function fixture() {
  const crypto = new LatticeCrypto();
  const recipient = await crypto.generateEncryptionKeyPair();
  const domainRequirement = {
    domainId: DOMAIN,
    sourceNamespaceId: NAMESPACE,
    participantDigest: bytes(1),
    participantCount: 1,
    keyClass: "ai" as const,
    domainKeyGeneration: 3,
    authorizationRevision: authorizationRevision(5),
    headDigest: bytes(2),
    activeNamespaceBindingSetDigest: bytes(3),
    activeNamespaceBindingCount: 1,
  };
  const namespaceRequirement = {
    ordinal: 0,
    namespaceId: NAMESPACE,
    domainId: DOMAIN,
    operations: ["decrypt", "encrypt"] as const,
    expectedAccessRevision: 4,
    expectedPolicyRevision: 17,
  };
  const authorization = createDomainForegroundAuthorizationPlan(crypto, {
    authorizationId: REQUEST,
    policyRevision: 17,
    sessionId: `task-run:${RUN}`,
    roomId: ROOM,
    subjectHumanId: humanId(HUMAN),
    committerDeviceId: cryptoDeviceId(DEVICE),
    committerDeviceSigningGeneration: 1,
    hostAuthorizationRevision: authorizationRevision(9),
    recipientKind: "runtime",
    recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(11),
    recipientRuntimeGeneration: 2,
    recipientKeyId: "fixed-memory-recipient",
    operations: ["decrypt", "encrypt"],
    issuedAt: NOW,
    deadlineAt: NOW + 60_000,
    maximumSecretBytes: 4_096,
    domains: [domainRequirement],
  });
  const request = createTaskRuntimeBackgroundAuthorizationRequestV1({
    requestId: REQUEST,
    workId: RUN,
    workKind: "task.execute",
    workPurpose: "task.execute",
    recipientGeneration: 2,
    episodeId: authorization.sessionId,
    sourceRoomId: authorization.roomId,
    recipientKeyId: authorization.recipientKeyId,
    recipientPublicKey: recipient.publicKey,
    authorizationPlan: authorization,
    issuedAt: NOW,
    deadlineAt: NOW + 60_000,
  });
  const evidenceInput: TaskRuntimeExecutionEvidenceInputV1 = {
    requestId: REQUEST,
    workId: RUN,
    claimId: "fixed-memory-claim",
    claimExpiresAt: NOW + 60_000,
    recipientExpiresAt: NOW + 60_000,
    expiresAt: NOW + 60_000,
    recipientGeneration: 2,
    recipientKeyId: authorization.recipientKeyId,
    authorizationDigest: bytes(4),
    policyRevision: 17,
    episodeId: authorization.sessionId,
    sourceRoomId: authorization.roomId,
    hostAuthorizationRevision: 9,
    recipientAuthorizationRevision: 11,
    result: {
      taskId: TASK,
      taskRunId: RUN,
      contentRevision: 1,
      objectId: RESULT_OBJECT,
      signerAgentId: AGENT,
      namespace: {
        namespaceId: NAMESPACE,
        domainId: DOMAIN,
        operations: ["encrypt"],
        expectedAccessRevision: 4,
        expectedPolicyRevision: 17,
      },
    },
    domainRequirements: [domainRequirement],
    namespaceRequirements: [namespaceRequirement],
  };
  recipient.privateKey.fill(0);
  const occurrence: ProtectedTaskOccurrence = {
    task: {id:TASK,ownerId:USER,requestorId:USER,agentId:AGENT,callingRoomId:ROOM,scheduleKind:"now",
      contentRepresentation:"protected",contentNamespaceId:NAMESPACE,contentRevision:1,
      cryptoObjectId:INPUT_OBJECT,cryptoAccessRevision:0,cryptoRequiredNamespaceFingerprint:bytes(5)},
    run: {id:RUN,taskId:TASK,jobId:null,graphThreadId:`subagent:task:${TASK}:${RUN}`,status:"awaiting",startedAt:new Date(NOW)},
  };
  const running: ProtectedTaskRunningOccurrence = {...occurrence,run:{...occurrence.run,status:"running",jobId:JOB}};
  const reference: TaskRuntimeGrantClaimPlan["reference"] = {kind:"protected_task_run_v1",taskId:TASK,taskRunId:RUN,
    inputObjectId:INPUT_OBJECT,resultObjectId:RESULT_OBJECT,authorizationRequestId:REQUEST,policyRevision:17,executionSegment:1};
  const policy = {mode:"encrypted_only" as const,shadowBehavior:"strict" as const,revision:17};
  const predispatch: ProtectedTaskPredispatchPlan = {occurrence,scheduling:{ownerId:USER,requestorId:USER,agentId:AGENT,roomId:ROOM,
    callingRoomId:ROOM,graphThreadId:running.run.graphThreadId},target:{roomId:ROOM,targetUserIds:[USER]},
    memory:{mode:"namespace",authorityStatus:"exact",provenance:"target_users_namespace",envelope:{
      memoryMode:"namespace",ownerId:USER,actorId:HUMAN,agentId:AGENT,roomId:ROOM,readableNamespaces:[NAMESPACE],
      mutableNamespaces:[NAMESPACE],writableNamespaces:[NAMESPACE],toolPolicy:{search_memory:"allow"}}}};
  const record = {snapshot:{formatVersion:3,requestId:REQUEST,workId:RUN,state:"claimed",claimId:"fixed-memory-claim",
    claimExpiresAt:NOW+60_000,recipientGeneration:2,acceptedResponse:{kind:"runtime",issuingHumanId:HUMAN,issuingDeviceId:DEVICE}},
    descriptorBytes:encodeTaskRuntimeBackgroundAuthorizationRequestV1(request),expectedNamespaceAccessRevision:4,
    expectedPolicyRevision:17,workKind:"task.execute",purpose:"task.execute",
    authoritySet:{namespaceRequirements:[namespaceRequirement],domainRequirements:[]}} as unknown as BackgroundAuthorizationTaskRuntimeRecordV3;
  const calls: string[] = [];
  const results: unknown[] = [];
  const transcripts: unknown[] = [];
  const registrations: Registration[] = [];
  const events: HarnessExecutionOutput[] = [candidate,completed];
  const providerEntered = Promise.withResolvers<void>();
  const control = {now:NOW,current:true,currentSelection:{...selection},admission:{...selection,scope:{...scope}} as ClaudeExecutionAdmission|null,
    metadata:{} as TaskPayloadV1["protectedMetadata"],liveRequest:true,failTranscript:false,signerCurrent:true,
    failResult:false,waitForAbort:false,effectCount:0,costCount:0,
    afterAdmission: (_count:number) => {},afterOutput: (_output:HarnessExecutionOutput) => {},
  };
  const abort = new AbortController();
  let admissionCount = 0;
  // Database/policy objects are inert: each consuming production boundary is overridden below.
  const input: Input = {crypto,db:{} as unknown as Input["db"],restricted:{} as unknown as Input["restricted"],
    serverScope:"https://server.example.test",owner:{} as unknown as Input["owner"],now:()=>control.now,
    controller:{admitExecution:async (user:string,selected:typeof selection)=>{
      expect(user).toBe(USER);expect(selected).toEqual(selection);calls.push("admit");
      admissionCount += 1;control.afterAdmission(admissionCount);return control.admission;
    }},
    execution:{async *start(admitted: Parameters<Input["execution"]["start"]>[0]) {
      expect(admitted.prompt).toBe("private task prompt");
      if (!control.admission) throw new Error("Provider started without current admission");
      expect(admitted.claude).toEqual(control.admission);
      expect(admitted).toMatchObject({taskId:TASK,taskRunId:RUN,jobId:JOB,requesterId:USER,ownerId:USER,laneKey:`task:${TASK}`});
      calls.push("provider");
      try {
        if (control.waitForAbort) {
          providerEntered.resolve();
          while (true) {
            admitted.abortSignal.throwIfAborted();
            control.effectCount += 1;
            control.costCount += 1;
            await new Promise(resolve => setTimeout(resolve, 1));
          }
        }
        for(const output of events) {yield output;control.afterOutput(output);}
      }
      finally {calls.push("provider-close");}
    },hasLiveRequest:()=>control.liveRequest,respond:async()=>{calls.push("respond");}},
    requests:{register:async (entry:Registration)=>{
      registrations.push(entry);await entry.assertCurrentExecutionAuthority();return {close:()=>{calls.push("question-close");}};
    }},
  };
  const dependencies: Dependencies = {
    product:async()=>({handle:{},canonicalRunner:{}} as Awaited<ReturnType<NonNullable<Dependencies["product"]>>>),
    currentAuthority:async operation=>{
      calls.push("current-definition"); if(!control.current)return null;
      return operation.use({foreground:{...authorization,committerDeviceSigningPublicKey:bytes(8),
        committerDeviceActive:true,recipientAuthorized:true},
        namespaceRequirements:[namespaceRequirement],claudeExecutionSelection:control.currentSelection});
    },
    memoryAuthority:async (_current,use)=>control.current ? use({policy,assertCurrent:async()=>{calls.push("current-memory");}} as Parameters<typeof use>[0]) : null,
    definition:async opened=>{
      expect(await opened.loadCurrentOccurrence()).toMatchObject({taskId:TASK,taskRunId:RUN,objectId:INPUT_OBJECT,namespaceId:NAMESPACE});
      calls.push("definition");return opened.execute({formatVersion:1,expectedOutput:null,prompt:"private task prompt",protectedMetadata:control.metadata},async()=>{
        if(await opened.loadCurrentOccurrence()===null)throw new Error("definition authority changed");
      });
    },
    signer:async signed=>{
      calls.push("signer");expect(signed.evidence.result.signerAgentId).toBe(AGENT);
      if(!control.signerCurrent)throw new Error("current signer unavailable");
      return signed.use({} as Parameters<typeof signed.use>[0],()=>null);
    },
    transcript:()=>async ()=>async publication=>{
      calls.push("transcript");if(control.failTranscript)throw new Error("cipher publication failed");transcripts.push(publication);
    },
  };
  const prepare = createProtectedTaskClaudeExecution(input,dependencies)(selection);
  const preparation = {occurrence,predispatch,reference,policy,stableRoutingDigest:bytes(12)};
  return {prepare,preparation,running,reference,record,evidenceInput,crypto,calls,results,transcripts,registrations,events,
    control,abort,providerEntered};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function withPrepared<Value>(f:Fixture,use:(value:{prepared:Awaited<ReturnType<Fixture["prepare"]>>;
  grant:Parameters<TaskRuntimeGrantClaimPlan["openTransientInput"]>[0]})=>Promise<Value>) {
  return withTaskRuntimeExecutionEvidenceV1({evidence:f.evidenceInput,signal:f.abort.signal,now:()=>f.control.now,
    execute:async evidence=>use({prepared:await f.prepare(f.preparation),
      grant:{occurrence:f.running,reference:f.reference,record:f.record,domains:[],evidence,signal:f.abort.signal}})});
}
async function consume(prepared:Awaited<ReturnType<Fixture["prepare"]>>,transient:Record<string,unknown>,job=JOB,lane=`task:${TASK}`) {
  const outputs=[];for await(const output of prepared.executor(transient,job,lane,new AbortController().signal))outputs.push(output);
  expect(outputs).toEqual([]);
}
function resultInput(f:Fixture,transient:Record<string,unknown>) {
  return {...transient,protectedTaskResultPublication:{publish:async(value:unknown)=>{
    f.calls.push("result");f.results.push(value);if(f.control.failResult)throw new Error("result publication unavailable");
  }}};
}

describe("protected Claude execution", () => {
  test("publishes exactly one protected transcript and result, without ordinary events", async () => {
    const f=await fixture();
    await withPrepared(f,async({prepared,grant})=>{
      const transient=resultInput(f,await prepared.openTransientInput(grant));
      await consume(prepared,transient);
      expect(f.results).toEqual([{formatVersion:1,resultText:"protected answer",lastError:null}]);
      expect(f.transcripts).toHaveLength(1);
      expect(f.transcripts[0]).toMatchObject({identity:{taskId:TASK,taskRunId:RUN,agentId:AGENT},payload:{content:"protected answer"}});
      expect(f.calls.indexOf("current-definition")).toBeLessThan(f.calls.indexOf("definition"));
      expect(f.calls.indexOf("signer")).toBeLessThan(f.calls.indexOf("provider"));
      expect(f.calls.indexOf("transcript")).toBeLessThan(f.calls.indexOf("result"));
      await Promise.resolve(expect(consume(prepared,transient)).rejects.toThrow());
      expect(f.calls.filter(x=>x==="provider")).toHaveLength(1);
    });
  });

  test("requires final-message boundary capability before definition disclosure", async () => {
    const f = await fixture();
    f.control.admission = { ...selection, scope: { ...scope, selectedProtocolVersion: 31 } };
    await withPrepared(f, async ({ prepared, grant }) => {
      await Promise.resolve(expect(prepared.openTransientInput(grant)).rejects.toBeInstanceOf(ProtectedTaskExecutionDidNotBeginError));
      expect(f.calls).not.toContain("definition");
      expect(f.calls).not.toContain("provider");
    });
  });

  test("rejects fabricated transient tokens before invoking caller code",async()=>{
    const f=await fixture();const prepared=await f.prepare(f.preparation);let invoked=false;
    await Promise.resolve(expect(consume(prepared,{protectedTaskClaudeExecution:{run:async()=>{invoked=true;}}})).rejects.toThrow());
    expect(invoked).toBe(false);
  });

  for(const substitution of ["task","run","reference","request","work","state","expiry"] as const) {
    test(`rejects ${substitution} substitution before protected definition disclosure`,async()=>{
      const f=await fixture();await withPrepared(f,async({prepared,grant})=>{
        const changed={...grant,occurrence:structuredClone(grant.occurrence),reference:{...grant.reference},record:structuredClone(grant.record)};
        if(substitution==="task")changed.occurrence={...changed.occurrence,task:{...changed.occurrence.task,id:ROOM}};
        if(substitution==="run")changed.occurrence={...changed.occurrence,run:{...changed.occurrence.run,id:ROOM}};
        if(substitution==="reference")changed.reference={...changed.reference,resultObjectId:INPUT_OBJECT};
        if(substitution==="request")changed.record={...changed.record,snapshot:{...changed.record.snapshot,requestId:"other-request"}};
        if(substitution==="work")changed.record={...changed.record,snapshot:{...changed.record.snapshot,workId:TASK}};
        if(substitution==="state")changed.record={...changed.record,snapshot:{...changed.record.snapshot,state:"running"}};
        if(substitution==="expiry")f.control.now=f.evidenceInput.expiresAt;
        await Promise.resolve(expect(prepared.openTransientInput(changed)).rejects.toThrow());
        expect(f.calls).not.toContain("definition");expect(f.calls).not.toContain("provider");
      });
    });
  }

  test("rejects a cloned evidence object and expired callback custody",async()=>{
    const f=await fixture();let escaped:Parameters<TaskRuntimeGrantClaimPlan["openTransientInput"]>[0]|undefined;
    const prepared=await f.prepare(f.preparation);
    await withPrepared(f,async({grant})=>{
      await Promise.resolve(expect(prepared.openTransientInput({...grant,evidence:{...grant.evidence}})).rejects.toThrow());escaped=grant;
    });
    await Promise.resolve(expect(prepared.openTransientInput(escaped!)).rejects.toThrow());
    expect(f.calls).not.toContain("provider");
  });

  for(const scenario of ["selection","authority","expired","metadata","offline","signer"] as const) {
    test(`rejects ${scenario} drift before provider starts`,async()=>{
      const f=await fixture();await withPrepared(f,async({prepared,grant})=>{
        if(scenario==="offline"){
          f.control.admission=null;await Promise.resolve(expect(prepared.openTransientInput(grant)).rejects.toBeInstanceOf(ProtectedTaskExecutionDidNotBeginError));return;
        }
        const transient=resultInput(f,await prepared.openTransientInput(grant));
        if(scenario==="selection")f.control.currentSelection={...selection,selectedModel:"another-model"};
        if(scenario==="authority")f.control.current=false;
        if(scenario==="expired")f.control.now=f.evidenceInput.expiresAt;
        if(scenario==="signer")f.control.signerCurrent=false;
        if(scenario==="metadata")f.control.metadata={workflow:{prompt:"not an ordinary Claude Task"}};
        await Promise.resolve(expect(consume(prepared,transient)).rejects.toThrow());
        expect(f.calls).not.toContain("provider");expect(f.results).toEqual([]);
      });
    });
  }

  for(const scenario of ["unavailable","changed"] as const) {
    test(`publishes one protected failure when second provider admission is ${scenario}`,async()=>{
      const f=await fixture();await withPrepared(f,async({prepared,grant})=>{
        const transient=resultInput(f,await prepared.openTransientInput(grant));
        f.control.admission=scenario==="unavailable"?null:
          {...selection,scope:{...scope,relaySessionId:"replacement-socket"}};
        await consume(prepared,transient);
        expect(f.results).toEqual([{formatVersion:1,resultText:null,lastError:"Protected Task execution failed"}]);
        expect(f.calls).not.toContain("provider");expect(f.calls.filter(value=>value==="result")).toHaveLength(1);
      });
    });
  }

  test("does not publish a second-admission failure after authority becomes stale",async()=>{
    const f=await fixture();await withPrepared(f,async({prepared,grant})=>{
      const transient=resultInput(f,await prepared.openTransientInput(grant));
      f.control.afterAdmission=count=>{if(count===2){f.control.admission=null;f.control.current=false;}};
      await Promise.resolve(expect(consume(prepared,transient)).rejects.toThrow("authority changed"));
      expect(f.results).toEqual([]);expect(f.calls).not.toContain("provider");
    });
  });

  test("does not publish a second-admission failure after cancellation",async()=>{
    const f=await fixture();await withPrepared(f,async({prepared,grant})=>{
      const transient=resultInput(f,await prepared.openTransientInput(grant));
      f.control.afterAdmission=count=>{if(count===2){f.control.admission=null;f.abort.abort(new DOMException("Grant revoked","AbortError"));}};
      await Promise.resolve(expect(consume(prepared,transient)).rejects.toMatchObject({name:"AbortError"}));
      expect(f.results).toEqual([]);expect(f.calls).not.toContain("provider");
    });
  });

  test("does not retry an uncertain protected failure publication",async()=>{
    const f=await fixture();await withPrepared(f,async({prepared,grant})=>{
      const transient=resultInput(f,await prepared.openTransientInput(grant));
      f.control.admission=null;f.control.failResult=true;
      await Promise.resolve(expect(consume(prepared,transient)).rejects.toThrow("result publication unavailable"));
      await Promise.resolve(expect(consume(prepared,transient)).rejects.toThrow());
      expect(f.results).toEqual([{formatVersion:1,resultText:null,lastError:"Protected Task execution failed"}]);
      expect(f.calls.filter(value=>value==="result")).toHaveLength(1);expect(f.calls).not.toContain("provider");
    });
  });

  test("rejects wrong lane, Job and another prepared operation's genuine token",async()=>{
    const f=await fixture();await withPrepared(f,async({prepared,grant})=>{
      const transient=resultInput(f,await prepared.openTransientInput(grant));
      await Promise.resolve(expect(consume(prepared,transient,JOB,"room:ordinary")).rejects.toThrow());
      await Promise.resolve(expect(consume(prepared,transient,ROOM)).rejects.toThrow());
      const other=await f.prepare(f.preparation);
      await Promise.resolve(expect(consume(other,transient)).rejects.toThrow());
      expect(f.calls).not.toContain("provider");
    });
  });

  test("unsupported resumed execution never fabricates provider checkpoint authority",async()=>{
    const f=await fixture();
    for(const kind of ["humanResume","checkpointResume","additionalAuthorityResume","checkpointAadBinding"] as const){
      const input={...f.preparation,[kind]:{}} as Parameters<Fixture["prepare"]>[0];
      await Promise.resolve(expect(f.prepare(input)).rejects.toThrow("unsupported"));
    }
    await Promise.resolve(expect(f.prepare({...f.preparation,reference:{...f.reference,executionSegment:2}})).rejects.toThrow());
    expect(f.calls).toEqual([]);
  });

  for(const scenario of ["stream-loss","failed-terminal","missing-candidate","duplicate-candidate","wrong-output","transcript-failure"] as const){
    test(`${scenario} cannot publish a result or replay the provider`,async()=>{
      const f=await fixture();
      if(scenario==="stream-loss")f.events.splice(1);
      if(scenario==="failed-terminal")f.events[1]={kind:"terminal",attribution,status:"failed",code:"process_lost"};
      if(scenario==="missing-candidate")f.events.splice(0,1);
      if(scenario==="duplicate-candidate")f.events.splice(1,0,candidate);
      if(scenario==="wrong-output")f.events[0]={...candidate,attribution:{...attribution,bindingGeneration:ROOM}};
      if(scenario==="transcript-failure")f.control.failTranscript=true;
      await withPrepared(f,async({prepared,grant})=>{
        const transient=resultInput(f,await prepared.openTransientInput(grant));
        await Promise.resolve(expect(consume(prepared,transient)).rejects.toThrow());
        await Promise.resolve(expect(consume(prepared,transient)).rejects.toThrow());
        expect(f.results).toEqual([]);expect(f.calls.filter(x=>x==="provider")).toHaveLength(1);
      });
    });
  }

  test("grant expiry after provider starts cannot commit a candidate",async()=>{
    const f=await fixture();
    f.control.afterOutput=output=>{if(output.kind==="assistant_completed")f.control.now=f.evidenceInput.expiresAt;};
    await withPrepared(f,async({prepared,grant})=>{
      const transient=resultInput(f,await prepared.openTransientInput(grant));
      await Promise.resolve(expect(consume(prepared,transient)).rejects.toThrow("expired"));
      expect(f.results).toEqual([]);expect(f.transcripts).toEqual([]);
      expect(f.calls).toContain("provider-close");
    });
  });

  test("time limit ends provider effects without publishing an uncertain result",async()=>{
    const f=await fixture();
    f.control.waitForAbort=true;
    await withPrepared(f,async({prepared,grant})=>{
      const transient=resultInput(f,await prepared.openTransientInput(grant));
      const execution=consume(prepared,transient);
      await f.providerEntered.promise;
      expect(prepared.requestCheckpointPause?.("time_limit",PAUSE_REQUEST)).toBe(true);
      await Promise.resolve(expect(execution).rejects.toThrow("time limit reached"));
      const settledEffects=f.control.effectCount;
      const settledCost=f.control.costCount;
      await new Promise(resolve=>setTimeout(resolve,5));
      expect(f.control.effectCount).toBe(settledEffects);
      expect(f.control.costCount).toBe(settledCost);
      expect(settledEffects).toBeGreaterThan(0);
      expect(f.calls).toContain("provider-close");
      expect(f.results).toEqual([]);
      expect(f.transcripts).toEqual([]);
    });
  });

  test("manual pause keeps an external provider running to natural settlement",async()=>{
    const f=await fixture();
    await withPrepared(f,async({prepared,grant})=>{
      expect(prepared.requestCheckpointPause?.("manual_pause",PAUSE_REQUEST)).toBe(false);
      await consume(prepared,resultInput(f,await prepared.openTransientInput(grant)));
      expect(f.results).toEqual([{formatVersion:1,resultText:"protected answer",lastError:null}]);
      expect(f.transcripts).toHaveLength(1);
    });
  });

  const privateQuestionBase = { attribution, requestId: "private-question", vendorRequestId: "private-vendor-question",
    ownerId: USER, expiresAt: new Date(NOW + 30_000).toISOString() };
  const privateQuestions: HarnessExecutionOutput[] = [
    { ...privateQuestionBase, kind: "command_approval_required", options: ["approve", "deny"], reason: "host_local_only",
      command: { detail: "host_local_only", actionKinds: ["read"] } },
    { ...privateQuestionBase, kind: "network_approval_required", options: ["approve", "deny"], reason: "host_local_only",
      network: { host: "private.example.test", protocol: "https" } },
    { ...privateQuestionBase, kind: "file_change_approval_required", options: ["approve", "deny"], reason: "host_local_only", grantRoot: "host_local_only" },
    { ...privateQuestionBase, kind: "permissions_approval_required", reason: "host_local_only", permissions: {
      network: { enabled: true }, fileSystem: { readPathCount: 1, writePathCount: 0, entryCount: 1, pathDetail: "host_local_only" } } },
    { ...privateQuestionBase, kind: "permission_selection_required", options: [{ id: "allow_once", label: "Allow once", semanticHint: null }],
      tool: { title: "Private operation", kind: null }, detail: { state: "shown", text: "Private detail" } },
    { ...privateQuestionBase, kind: "user_input_required", autoResolutionMs: null,
      questions: [{ id: "choice", header: "Question", prompt: "private question", secret: false, multiSelect: false, allowOther: true, options: null }] },
  ];

  for (const question of privateQuestions) {
    test(`${question.kind} enters only protected ephemeral custody and never ordinary output`, async () => {
      const f = await fixture();
      f.events.unshift(question);
      await withPrepared(f, async ({ prepared, grant }) => {
        await consume(prepared, resultInput(f, await prepared.openTransientInput(grant)));
        expect(f.registrations).toHaveLength(1);
        expect(await f.registrations[0]!.read()).toMatchObject({ type: "codex.request", ownerId: USER,
          taskId: TASK, jobId: JOB, roomId: ROOM, requestId: "private-question", request: { kind: question.kind } });
        expect(f.registrations[0]!.deadlineAt).toBe(f.evidenceInput.expiresAt);
        expect(f.calls).toContain("question-close");
        expect(f.calls).not.toContain("respond");
        expect(f.transcripts).toHaveLength(1);
        expect(f.results).toEqual([{ formatVersion: 1, resultText: "protected answer", lastError: null }]);
      });
    });
  }

  test("questions use only the live private registry, close on abort and retain current authority checks",async()=>{
    const f=await fixture();
    f.events.unshift({kind:"user_input_required",attribution,requestId:"provider-question",vendorRequestId:"question-1",
      ownerId:USER,expiresAt:new Date(NOW+30_000).toISOString(),autoResolutionMs:null,
      questions:[{id:"choice",header:"Question",prompt:"private question",secret:false,multiSelect:false,allowOther:true,options:null}]});
    f.control.afterOutput=output=>{if(output.kind==="user_input_required")f.abort.abort(new DOMException("Grant revoked","AbortError"));};
    await withPrepared(f,async({prepared,grant})=>{
      const transient=resultInput(f,await prepared.openTransientInput(grant));
      await Promise.resolve(expect(consume(prepared,transient)).rejects.toMatchObject({name:"AbortError"}));
      expect(f.registrations).toHaveLength(1);
      const request=f.registrations[0]!;
      expect(request.identity).toEqual({taskId:TASK,taskRunId:RUN,jobId:JOB,sourceRoomId:ROOM,namespaceId:NAMESPACE,
        requestorId:USER,humanActorId:HUMAN,agentId:AGENT,roomId:ROOM,requestId:"provider-question"});
      expect(await request.read()).toMatchObject({type:"codex.request",requestId:"provider-question"});
      await Promise.resolve(expect(request.assertCurrentExecutionAuthority()).rejects.toMatchObject({name:"AbortError"}));
      f.control.liveRequest=false;expect(await request.read()).toBeNull();
      expect(f.calls).toContain("question-close");expect(f.calls).toContain("provider-close");
      expect(f.transcripts).toEqual([]);expect(f.results).toEqual([]);expect(f.calls).not.toContain("respond");
    });
  });
});
