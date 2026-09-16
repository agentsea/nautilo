import type { DtoDeclaration } from "../src/node/dto-inventory";

export const REVIEWED_M303_DTO_DECLARATIONS: readonly DtoDeclaration[] = [
  {
    observationId:
      "wire.http.request.response.get.api.crypto.device.admission.status.18soygn",
    locator: "http:request_response:GET /api/crypto-device-admission/status",
    structuralSignatures: [
      "response.body:{deviceGeneration:number;deviceId:string;expiresAt:number;required:true;responseVersion:1;status:\"admitted\"}|{reason:\"device_admission_expired\"|\"device_admission_required\"|\"device_removed_or_stale\";required:true;responseVersion:1;status:\"required\"}",
      "response.body:{error:string;retryable:boolean}",
      "response.body:{required:boolean;responseVersion:1;status:\"not_required\"}",
    ],
    arbitraryPayloads: [],
  },
  {
    observationId:
      "wire.http.request.response.post.api.crypto.device.admission.challenge.rgr2oc",
    locator:
      "http:request_response:POST /api/crypto-device-admission/challenge",
    structuralSignatures: [
      "response.body:{challenge:{challengeId:string;credentialDigestBase64url:string;deviceGeneration:number;deviceId:string;epoch:number;expiresAt:number;formatVersion:1;headDigestBase64url:string;humanActorId:string;issuedAt:number;lineageGeneration:number;nonceBase64url:string;securityRevision:number;serverInstanceId:string;userId:string};responseVersion:1}",
      "response.body:{error:string;retryable:boolean}",
    ],
    arbitraryPayloads: [],
  },
  {
    observationId:
      "wire.http.request.response.post.api.crypto.device.admission.proof.1fthtcr",
    locator: "http:request_response:POST /api/crypto-device-admission/proof",
    structuralSignatures: [
      "response.body:{deviceGeneration:number;deviceId:string;expiresAt:number;responseVersion:1;status:\"admitted\"}",
      "response.body:{error:string;retryable:boolean}",
    ],
    arbitraryPayloads: [],
  },
];
