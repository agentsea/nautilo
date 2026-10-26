import { afterEach, describe, expect, test } from "bun:test";
import Fastify, {type LightMyRequestResponse} from "fastify";
import { getMaintenanceGate, setMaintenanceGate, MaintenanceDrainError } from "@nautilo/runtime";
import { AgentInvocationDeniedError, assertAcceptedInvocationAuthoritySubject } from "@nautilo/trust";
import { LatticeCrypto, authorizationRevision, createDomainForegroundAuthorizationPlan, cryptoDeviceId, humanId } from "@nautilo/lattice-crypto";
import { serializeDomainForegroundAuthorizationPlanV2 } from "@nautilo/lattice-crypto/wire";
import type { ProtectedTaskExternalResponseCapability } from "../../src/routes/protected-task-external-requests";
import { protectedTaskExternalRequestRoutes } from "../../src/routes/protected-task-external-request-routes";

const USER="11111111-1111-4111-8111-111111111111";
const HUMAN="22222222-2222-4222-8222-222222222222";
const ROOM="33333333-3333-4333-8333-333333333333";
const CHALLENGE="44444444-4444-4444-8444-444444444444";
// A wire-only fake registry token; no production capability owner consumes it in this route test.
const CAPABILITY="55555555-5555-4555-8555-555555555555" as ProtectedTaskExternalResponseCapability;
const binding={clientActionSessionId:"browser-session",authorizationDeviceId:"current-device"};
const expectedBinding={userId:USER,humanActorId:HUMAN,clientDeviceId:binding.authorizationDeviceId,clientActionSessionId:binding.clientActionSessionId};
const headers={authorization:"Bearer authenticated"};
const respondBody={...binding,requestId:"provider-request",responseCapability:CAPABILITY,
  response:{kind:"permission_selection_required",outcome:{kind:"selected",optionId:"allow_once"}}};
const event={type:"codex.request" as const,ownerId:USER,requestId:"provider-request",taskId:USER,jobId:ROOM,roomId:ROOM,expiresAt:new Date(180_001).toISOString(),
  request:{kind:"permission_selection_required" as const,options:[{id:"allow_once",label:"Allow once",semanticHint:null}],tool:{title:null,kind:null}}};
const paths=["","/plan","/read","/respond"] as const;
const bodyFor=(path:typeof paths[number])=>path===""?binding:path==="/plan"?{...binding,requestId:"provider-request"}:
  path==="/read"?{...binding,challengeId:CHALLENGE,authorizationBytesBase64url:"AQID"}:respondBody;
const originalGate=getMaintenanceGate();
afterEach(()=>setMaintenanceGate(originalGate));
type Service=NonNullable<Awaited<ReturnType<Parameters<typeof protectedTaskExternalRequestRoutes>[1]["service"]>>>;
function noStore(response:LightMyRequestResponse){
  expect(response.headers["cache-control"]).toBe("private, no-store");expect(response.headers["vary"]).toBe("Authorization");
}
function setup(){
  const app=Fastify({logger:false});const calls:string[]=[];const received:unknown[]=[];
  const control={guest:false,missingHuman:false,missingService:false,throwService:false,denyInvocation:false,failInvocation:false,
    readBytes:undefined as Uint8Array|undefined,plan:null as Awaited<ReturnType<Service["plan"]>>|null,responded:false,
    listState:"available" as "available"|"unavailable"};
  app.addHook("preHandler",(request,_reply,done)=>{
    const authenticated=request.headers.authorization===headers.authorization;
    request.sessionUserId=authenticated?USER:null;
    request.sessionActorId=authenticated&&!control.missingHuman?HUMAN:null;
    request.policyContext=authenticated?{actorRole:control.guest?"guest":"member"} as typeof request.policyContext:null;
    done();
  });
  const service: Service={
    register:async()=>{throw new Error("Route must not register provider requests");},
    cancelForDevice:()=>{throw new Error("Route must not cancel devices");},
    cancelForClientSession:()=>{throw new Error("Route must not cancel sessions");},
    cancelForHuman:()=>{throw new Error("Route must not cancel Humans");},
    close:()=>{throw new Error("Route must not close registry");},
    list:async(current:Parameters<Service["list"]>[0])=>{calls.push("list");received.push(current);return control.listState==="available"?[]:[{
      requestId:"provider-request",taskId:USER,taskRunId:ROOM,jobId:CHALLENGE,roomId:ROOM,ownerId:USER,state:"unavailable" as const,
    }];},
    plan:async(current:Parameters<Service["plan"]>[0])=>{calls.push("plan");received.push(current);return control.plan??{status:"unavailable" as const};},
    read:async(current:Parameters<Service["read"]>[0])=>{calls.push("read");received.push(current);control.readBytes=current.authorizationBytes;
      expect(Array.from(current.authorizationBytes)).toEqual([1,2,3]);return {status:"read" as const,event,responseCapability:CAPABILITY};},
    respond:async(current:Parameters<Service["respond"]>[0])=>{
      calls.push("respond");received.push(current);assertAcceptedInvocationAuthoritySubject(current.invocationAuthority,USER);
      if(control.responded)return {status:"unavailable" as const};control.responded=true;return {status:"responded" as const};
    },
  };
  protectedTaskExternalRequestRoutes(app,{service:async()=>{calls.push("service");if(control.throwService)throw new Error("private internal failure");
      return control.missingService?null:service;},
    assertCanInvokeAgent:async input=>{calls.push("invocation");expect(input).toEqual({humanUserId:USER,origin:"foreground_resume"});
      if(control.denyInvocation)throw new AgentInvocationDeniedError(input);if(control.failInvocation)throw new Error("authority unavailable");},
  });
  const inject=(path:typeof paths[number],payload:unknown=bodyFor(path),authenticated=true)=>app.inject({method:"POST",
    url:`/api/tasks/external-requests${path}`,headers:authenticated?headers:{},payload:payload as Record<string,unknown>});
  return {app,calls,received,control,inject};
}

describe("protected external request routes",()=>{
  test("requires authenticated User and Human, rejects guests before any registry access",async()=>{
    for(const mode of ["unsigned","missing-human","guest"]){
      const f=setup();f.control.missingHuman=mode==="missing-human";f.control.guest=mode==="guest";
      try {for(const path of paths){const response=await f.inject(path,bodyFor(path),mode!=="unsigned");
        expect(response.statusCode).toBe(401);noStore(response);}expect(f.calls).toEqual([]);}
      finally {await f.app.close();}
    }
  });
  test("rejects extra caller identity and malformed binding before invoking service",async()=>{
    const f=setup();try {
      for(const path of paths)for(const extra of [{ownerId:"attacker"},{humanActorId:"attacker"},{authorizationDeviceId:""}]){
        const response=await f.inject(path,{...bodyFor(path),...extra});expect(response.statusCode).toBe(400);noStore(response);
      }
      expect(f.calls).toEqual([]);
    }finally {await f.app.close();}
  });
  test("missing Plain service and unavailable service disclose no requests on all routes",async()=>{
    for(const failure of ["missing","throw"]){const f=setup();f.control.missingService=failure==="missing";f.control.throwService=failure==="throw";
      try{for(const path of paths){const response=await f.inject(path);expect(response.statusCode).toBe(200);
        expect(response.json<unknown>()).toEqual({status:"unavailable"});noStore(response);}}
      finally{await f.app.close();}
    }
  });
  test("passes only server identity and exact device/session; read bytes are erased after return",async()=>{
    const f=setup();try{
      const list=await f.inject("");expect(list.json<unknown>()).toEqual({status:"ready",requests:[]});noStore(list);
      expect(f.received[0]).toEqual(expectedBinding);
      const read=await f.inject("/read");expect(read.json<unknown>()).toEqual({status:"read",event,responseCapability:CAPABILITY});noStore(read);
      expect(f.received[1]).toMatchObject({binding:expectedBinding,challengeId:CHALLENGE});
      expect(Array.from(f.control.readBytes!)).toEqual([0,0,0]);
    }finally{await f.app.close();}
  });
  test("fails closed when an internal registry state is outside the public DTO",async()=>{
    const f=setup();f.control.listState="unavailable";
    try{const response=await f.inject("");expect(response.statusCode).toBe(200);
      expect(response.json<unknown>()).toEqual({status:"unavailable"});noStore(response);
      expect(f.calls).toEqual(["service","list"]);
    }finally{await f.app.close();}
  });
  test("rejects noncanonical base64 before reading",async()=>{
    const f=setup();try{
      for(const encoded of ["", "AQID=", "AQID\n", "@@@", "A"]){
        const response=await f.inject("/read",{...bodyFor("/read"),authorizationBytesBase64url:encoded});
        expect(response.statusCode).toBe(400);noStore(response);
      }expect(f.calls).toEqual([]);
    }finally{await f.app.close();}
  });
  test("serializes genuine authorization plan, exact Room and public recipient then wipes owned bytes",async()=>{
    const f=setup();const crypto=new LatticeCrypto();const bytes=()=>new Uint8Array(32).fill(1);
    const plan=createDomainForegroundAuthorizationPlan(crypto,{authorizationId:CHALLENGE,policyRevision:1,sessionId:"read-session",roomId:ROOM,
      subjectHumanId:humanId(HUMAN),committerDeviceId:cryptoDeviceId(binding.authorizationDeviceId),committerDeviceSigningGeneration:1,
      hostAuthorizationRevision:authorizationRevision(1),recipientKind:"runtime",recipientPrincipalId:"read-runtime",
      recipientAuthorizationRevision:authorizationRevision(1),recipientRuntimeGeneration:1,recipientKeyId:"read-key",
      operations:["decrypt"],issuedAt:1,deadlineAt:60_001,maximumSecretBytes:4096,
      domains:[{domainId:"domain",sourceNamespaceId:"namespace",participantDigest:bytes(),participantCount:1,keyClass:"ai",
        domainKeyGeneration:1,authorizationRevision:authorizationRevision(1),headDigest:bytes(),activeNamespaceBindingSetDigest:bytes(),activeNamespaceBindingCount:1}]});
    const encoded=serializeDomainForegroundAuthorizationPlanV2(plan);const recipient=bytes();
    const wire=Buffer.from(encoded).toString("base64url");const key=Buffer.from(recipient).toString("base64url");
    f.control.plan={status:"authorization_required",challengeId:CHALLENGE,deadlineAt:60_001,requestDeadlineAt:180_001,authorizationPlanBytes:encoded,recipientPublicKey:recipient};
    try{const response=await f.inject("/plan");expect(response.json<unknown>()).toEqual({status:"authorization_required",challengeId:CHALLENGE,
      roomId:ROOM,deadlineAt:60_001,requestDeadlineAt:180_001,authorizationPlanBytesBase64url:wire,recipientPublicKeyBase64url:key});noStore(response);
      expect(f.received[0]).toEqual({requestId:"provider-request",binding:expectedBinding});
      expect(encoded.every(byte=>byte===0)).toBe(true);expect(recipient.every(byte=>byte===0)).toBe(true);
    }finally{await f.app.close();}
  });
  test("malformed plan bytes fail closed and wipe both owned buffers",async()=>{
    const f=setup();const encoded=new Uint8Array([1,2,3]);const recipient=new Uint8Array(32).fill(7);
    f.control.plan={status:"authorization_required",challengeId:CHALLENGE,deadlineAt:60_001,requestDeadlineAt:180_001,authorizationPlanBytes:encoded,recipientPublicKey:recipient};
    try{const response=await f.inject("/plan");expect(response.json<unknown>()).toEqual({status:"unavailable"});noStore(response);
      expect([...encoded]).toEqual([0,0,0]);expect(recipient.every(byte=>byte===0)).toBe(true);
    }finally{await f.app.close();}
  });
  test("response checks invocation and maintenance before provider and ignores no owner supplied by client",async()=>{
    const f=setup();setMaintenanceGate({assertAcceptingNewWork:async()=>{f.calls.push("maintenance");},isAcceptingWork:async()=>true});
    try{
      const denied=await f.inject("/respond",{...respondBody,response:{...respondBody.response,ownerId:"attacker"}});
      expect(denied.statusCode).toBe(400);expect(f.calls).toEqual([]);
      const response=await f.inject("/respond");expect(response.json<unknown>()).toEqual({status:"responded"});noStore(response);
      expect(f.calls).toEqual(["invocation","maintenance","service","respond"]);
      expect(f.received[0]).toMatchObject({binding:expectedBinding,responseCapability:CAPABILITY,
        response:{...respondBody.response,ownerId:USER,requestId:"provider-request"}});
      const replay=await f.inject("/respond");expect(replay.json<unknown>()).toEqual({status:"unavailable"});noStore(replay);
    }finally{await f.app.close();}
  });
  test("invocation denial or unavailable lookup never reaches maintenance or provider",async()=>{
    for(const fails of [false,true]){const f=setup();f.control.denyInvocation=!fails;f.control.failInvocation=fails;
      setMaintenanceGate({assertAcceptingNewWork:async()=>{throw new Error("must not reach maintenance");},isAcceptingWork:async()=>true});
      try{const response=await f.inject("/respond");expect(response.statusCode).toBe(fails?500:403);noStore(response);
        expect(f.calls).toEqual(["invocation"]);}finally{await f.app.close();}
    }
  });
  test("draining rejects response without consuming provider capability",async()=>{
    const f=setup();setMaintenanceGate({assertAcceptingNewWork:async()=>{throw new MaintenanceDrainError("draining");},isAcceptingWork:async()=>false});
    try{const response=await f.inject("/respond");expect(response.statusCode).toBe(503);noStore(response);
      expect(response.json<unknown>()).toMatchObject({code:"maintenance_draining",retryable:true});
      expect(f.calls).toEqual(["invocation"]);expect(f.control.responded).toBe(false);
    }finally{await f.app.close();}
  });
  test("parser errors also cannot cache protected route responses",async()=>{
    const f=setup();try{
      const response=await f.app.inject({method:"POST",url:"/api/tasks/external-requests/read",headers:{...headers,"content-type":"application/json"},payload:"{"});
      expect(response.statusCode).toBe(400);noStore(response);expect(f.calls).toEqual([]);
    }finally{await f.app.close();}
  });
});
