import { describe, expect, test } from "bun:test";
import { NautiloApiClient } from "../../src/client";
import {
  protectedTaskExternalRequestBindingSchema as bindingSchema,
  protectedTaskExternalRequestPlanBodySchema as planBodySchema,
  protectedTaskExternalRequestReadBodySchema as readBodySchema,
  protectedTaskExternalRequestRespondBodySchema as respondBodySchema,
  protectedTaskExternalRequestListSchema as listSchema,
  protectedTaskExternalRequestPlanSchema as planSchema,
  protectedTaskExternalRequestReadSchema as readSchema,
  protectedTaskExternalRequestRespondSchema as respondSchema,
} from "../../src/schemas/protected-task-external-requests";

const id="11111111-1111-4111-8111-111111111111";
const binding={clientActionSessionId:"browser-session",authorizationDeviceId:"current-device"};
const permission={kind:"permission_selection_required" as const,outcome:{kind:"selected" as const,optionId:"allow_once"}};
const respond={...binding,requestId:"provider-request",responseCapability:id,response:permission};
const event={type:"codex.request" as const,ownerId:id,requestId:"provider-request",taskId:id,jobId:id,roomId:id,expiresAt:null,
  request:{kind:"permission_selection_required" as const,options:[{id:"allow_once",label:"Allow once",semanticHint:null}],tool:{title:null,kind:null}}};

describe("protected external request wire schemas",()=>{
  test("accepts closed device binding, signed read challenge and capability response",()=>{
    expect(bindingSchema.parse(binding)).toEqual(binding);
    expect(planBodySchema.parse({...binding,requestId:"provider-request"})).toEqual({...binding,requestId:"provider-request"});
    expect(readBodySchema.safeParse({...binding,challengeId:id,authorizationBytesBase64url:"AQID"}).success).toBe(true);
    expect(respondBodySchema.parse(respond)).toEqual(respond);
  });
  test("rejects owner, identity, unknown and prototype fields at every request boundary",()=>{
    const cases=[{schema:bindingSchema,body:binding},{schema:planBodySchema,body:{...binding,requestId:"r"}},
      {schema:readBodySchema,body:{...binding,challengeId:id,authorizationBytesBase64url:"AQID"}},
      {schema:respondBodySchema,body:respond}];
    for(const {schema,body} of cases){
      for(const name of ["ownerId","userId","humanActorId","taskId","agentId","unknown","__proto__","constructor","prototype"]){
        const forged=JSON.parse(JSON.stringify(body).slice(0,-1)+`,"${name}":"forged"}`) as unknown;
        expect(schema.safeParse(forged).success).toBe(false);
      }
    }
    for(const extra of [{ownerId:id},{requestId:"other"},{prompt:"injected"},{__proto__:null,unknown:true}]){
      expect(respondBodySchema.safeParse({...respond,response:{...permission,...extra}}).success).toBe(false);
    }
  });
  test("keeps the exact existing closed permission and question response variants",()=>{
    const valid=[permission,{kind:"permission_selection_required" as const,outcome:{kind:"cancelled"}},
      {kind:"user_input_required",answers:{question:["yes"]}},
      ...["command_approval_required","network_approval_required","file_change_approval_required"].map(kind=>({kind,decision:"approve"})),
      {kind:"permissions_approval_required",grants:{network:false,fileSystem:true},scope:"turn"}];
    for(const response of valid)expect(respondBodySchema.safeParse({...respond,response}).success).toBe(true);
    for(const response of [{kind:"unknown"},{kind:"user_input_required",answers:{q:[]}},
      {kind:"permission_selection_required" as const,outcome:{kind:"selected" as const}},
      {kind:"permission_selection_required" as const,outcome:{kind:"cancelled",optionId:"allow"}},
      {kind:"permissions_approval_required",grants:{network:true,fileSystem:true,admin:true},scope:"turn"},
      {kind:"command_approval_required",decision:"always_admin"}]){
      expect(respondBodySchema.safeParse({...respond,response}).success).toBe(false);
    }
  });
  test("requires opaque UUID challenge/capability, nonempty binding and exact public response shapes",()=>{
    for(const invalid of ["",null,[],{}]){
      expect(bindingSchema.safeParse({...binding,authorizationDeviceId:invalid}).success).toBe(false);
      expect(respondBodySchema.safeParse({...respond,responseCapability:invalid}).success).toBe(false);
    }
    expect(readBodySchema.safeParse({...binding,challengeId:"not-a-challenge",authorizationBytesBase64url:"AQID"}).success).toBe(false);
    for(const schema of [listSchema,planSchema,readSchema,respondSchema]){
      expect(schema.parse({status:"unavailable"})).toEqual({status:"unavailable"});
      expect(schema.safeParse({status:"unavailable",event}).success).toBe(false);
    }
    expect(listSchema.safeParse({status:"ready",requests:[{requestId:"r",taskId:id,taskRunId:id,jobId:id,roomId:id,ownerId:id,state:"available"}]}).success).toBe(true);
    expect(planSchema.safeParse({status:"authorization_required",challengeId:id,roomId:id,deadlineAt:1,requestDeadlineAt:2,
      authorizationPlanBytesBase64url:"AQID",recipientPublicKeyBase64url:"AQID"}).success).toBe(true);
    expect(planSchema.safeParse({status:"authorization_required",challengeId:id,roomId:id,deadlineAt:1,
      authorizationPlanBytesBase64url:"AQID",recipientPublicKeyBase64url:"AQID"}).success).toBe(false);
    expect(readSchema.parse({status:"read",event,responseCapability:id})).toEqual({status:"read",event,responseCapability:id});
    expect(readSchema.safeParse({status:"read",event:{...event,privateKey:"forged"},responseCapability:id}).success).toBe(false);
    expect(respondSchema.parse({status:"responded"})).toEqual({status:"responded"});
  });
});


test("all four client methods use POST, closed bodies, cancellation and response validation without network",async()=>{
  const original=globalThis.fetch;
  const calls:{url:string;init:RequestInit|undefined}[]=[];
  let returned:unknown={status:"unavailable"};
  const fake=async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
    calls.push({url:typeof input==="string"?input:input instanceof URL?input.toString():input.url,init});
    return new Response(JSON.stringify(returned),{status:200,headers:{"content-type":"application/json"}});
  };
  globalThis.fetch=Object.assign(fake,{preconnect:original.preconnect.bind(original)}) as typeof fetch;
  const client=new NautiloApiClient("https://unit.invalid");client.setToken("synthetic-token");
  const signal=new AbortController().signal;
  try{
    expect(await client.listProtectedTaskExternalRequests(binding,{signal})).toEqual({status:"unavailable"});
    expect(await client.planProtectedTaskExternalRequest({...binding,requestId:"r"},{signal})).toEqual({status:"unavailable"});
    expect(await client.readProtectedTaskExternalRequest({...binding,challengeId:id,authorizationBytesBase64url:"AQID"},{signal})).toEqual({status:"unavailable"});
    expect(await client.respondProtectedTaskExternalRequest(respondBodySchema.parse(respond),{signal})).toEqual({status:"unavailable"});
    expect(calls.map(call=>call.url)).toEqual(["","/plan","/read","/respond"].map(path=>`https://unit.invalid/api/tasks/external-requests${path}`));
    for(const call of calls){expect(call.init?.method).toBe("POST");expect(call.init?.signal).toBe(signal);
      expect(new Headers(call.init?.headers).get("Authorization")).toBe("Bearer synthetic-token");}
    const sentBody=calls[3]?.init?.body;
    if(typeof sentBody!=="string")throw new Error("expected JSON body");
    expect(JSON.parse(sentBody)).toEqual(respond);
    await Promise.resolve(expect(client.listProtectedTaskExternalRequests({...binding,ownerId:id} as typeof binding)).rejects.toThrow());
    expect(calls).toHaveLength(4);
    returned={status:"read",event,responseCapability:"not-a-capability"};
    await Promise.resolve(expect(client.readProtectedTaskExternalRequest({...binding,challengeId:id,authorizationBytesBase64url:"AQID"})).rejects.toThrow());
  }finally{globalThis.fetch=original;}
});
