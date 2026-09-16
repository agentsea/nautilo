import { z } from "zod";
import {
  MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2,
  MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2,
} from "@nautilo/lattice-crypto/background";

export const BACKGROUND_AUTHORIZATION_MAX_LIST_REQUESTS = 256;
export const BACKGROUND_AUTHORIZATION_MAX_REQUEST_PAGE_WIRE_BYTES =
  MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2;

function maximumBase64urlCharacters(bytes: number): number {
  return Math.ceil(bytes * 4 / 3);
}

function base64urlDecodedBytes(characters: number): number {
  return Math.floor(characters * 3 / 4);
}

export const BACKGROUND_AUTHORIZATION_MAX_REQUEST_CHARACTERS =
  maximumBase64urlCharacters(
    MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2,
  );
export const BACKGROUND_AUTHORIZATION_MAX_RESPONSE_CHARACTERS =
  maximumBase64urlCharacters(
    MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2,
  );

const canonicalBase64url = z.string().min(1).regex(/^[A-Za-z0-9_-]+$/u)
  .refine((value) => value.length % 4 !== 1);
const requestCarrier = canonicalBase64url.max(
  BACKGROUND_AUTHORIZATION_MAX_REQUEST_CHARACTERS,
);
const responseCarrier = canonicalBase64url.max(
  BACKGROUND_AUTHORIZATION_MAX_RESPONSE_CHARACTERS,
);

export const backgroundAuthorizationListRequestSchema = z.object({
  requestVersion: z.literal(1),
  continuation: canonicalBase64url.optional(),
}).strict();

export const backgroundAuthorizationListResponseSchema = z.object({
  responseVersion: z.literal(1),
  requests: z.array(z.object({
    requestBytesBase64url: requestCarrier,
  }).strict()).max(BACKGROUND_AUTHORIZATION_MAX_LIST_REQUESTS)
    .superRefine((requests, context) => {
      let bytes = 0;
      for (const request of requests) {
        bytes += base64urlDecodedBytes(request.requestBytesBase64url.length);
        if (bytes > BACKGROUND_AUTHORIZATION_MAX_REQUEST_PAGE_WIRE_BYTES) {
          context.addIssue({
            code: "custom",
            message: "Background authorization request page is oversized",
          });
          return;
        }
      }
    }),
  continuation: canonicalBase64url.optional(),
}).strict();

export const backgroundAuthorizationRespondRequestSchema = z.object({
  requestVersion: z.literal(1),
  responseBytesBase64url: responseCarrier,
}).strict();

export const backgroundAuthorizationRespondResponseSchema = z.object({
  responseVersion: z.literal(1),
  status: z.enum([
    "accepted",
    "duplicate",
    "stale",
    "unauthorized",
    "superseded",
    "malformed",
  ]),
}).strict();

export type BackgroundAuthorizationListRequest = z.infer<
  typeof backgroundAuthorizationListRequestSchema
>;
export type BackgroundAuthorizationListResponse = z.infer<
  typeof backgroundAuthorizationListResponseSchema
>;
export type BackgroundAuthorizationRespondRequest = z.infer<
  typeof backgroundAuthorizationRespondRequestSchema
>;
export type BackgroundAuthorizationRespondResponse = z.infer<
  typeof backgroundAuthorizationRespondResponseSchema
>;
