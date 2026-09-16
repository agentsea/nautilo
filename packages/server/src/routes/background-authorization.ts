import type { FastifyInstance, FastifyRequest } from "fastify";

import type { CurrentDeviceAdmission } from "../auth/device-admission-gate";
import { decodeCanonicalBase64url } from "../lib/canonical-base64url";
import { liveShadowLargeRequestRouteOptions } from "./live-shadow-request-boundary";

export interface BackgroundAuthorizationDeviceSubject {
  readonly userId: string;
  readonly humanActorId: string;
  readonly deviceId: string;
  readonly admission: CurrentDeviceAdmission;
}

export interface BackgroundAuthorizationDeviceProtocolLimits {
  /** Maximum bytes in one opaque request returned by discovery. */
  readonly requestBytes: number;
  /** Maximum aggregate opaque request bytes returned by one page. */
  readonly requestPageBytes: number;
  /** Maximum opaque requests returned by one page. */
  readonly maximumRequests: number;
  /** Maximum bytes in one opaque fulfillment or refusal submission. */
  readonly responseBytes: number;
  /** Maximum ASCII characters in the service-owned stable continuation. */
  readonly continuationCharacters: number;
}

export interface BackgroundAuthorizationDeviceListResult {
  readonly requests: readonly Readonly<{ readonly requestBytes: Uint8Array }>[];
  readonly continuation?: string;
}

export type BackgroundAuthorizationDeviceRespondStatus =
  | "accepted"
  | "duplicate"
  | "stale";

export class BackgroundAuthorizationDeviceServiceError extends Error {
  constructor(
    readonly status: "unauthorized" | "superseded" | "malformed",
  ) {
    super(status);
    this.name = "BackgroundAuthorizationDeviceServiceError";
  }
}

export interface BackgroundAuthorizationDeviceService {
  readonly limits: BackgroundAuthorizationDeviceProtocolLimits;
  readonly list: (
    subject: BackgroundAuthorizationDeviceSubject,
    input: Readonly<{ readonly continuation?: string }>,
  ) => Promise<BackgroundAuthorizationDeviceListResult>;
  readonly respond: (
    subject: BackgroundAuthorizationDeviceSubject,
    input: Readonly<{ readonly responseBytes: Uint8Array }>,
  ) => Promise<Readonly<{
    readonly status: BackgroundAuthorizationDeviceRespondStatus;
  }>>;
}

type AcknowledgementStatus = BackgroundAuthorizationDeviceRespondStatus
  | BackgroundAuthorizationDeviceServiceError["status"];

const VERSION = 1 as const;
const BASE64URL = /^[A-Za-z0-9_-]*$/u;

function encodedLength(bytes: number): number {
  return Math.ceil(bytes * 4 / 3);
}

function assertLimits(
  limits: BackgroundAuthorizationDeviceProtocolLimits,
): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`Background authorization ${name} limit is invalid`);
    }
  }
  if (limits.requestPageBytes < limits.requestBytes) {
    throw new TypeError(
      "Background authorization page cannot hold one maximum request",
    );
  }
}

function exactObject(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index]);
}

function subject(request: FastifyRequest): BackgroundAuthorizationDeviceSubject {
  const admission = request.cryptoDeviceAdmission;
  if (
    !request.sessionUserId
    || !request.sessionActorId
    || !admission
    || admission.expiresAt <= Date.now()
  ) {
    throw Object.assign(
      new Error("Current device admission is required"),
      { statusCode: 428 },
    );
  }
  return Object.freeze({
    userId: request.sessionUserId,
    humanActorId: request.sessionActorId,
    deviceId: admission.deviceId,
    admission,
  });
}

function acknowledgement(status: AcknowledgementStatus) {
  return Object.freeze({ responseVersion: VERSION, status });
}

/**
 * Authenticated transport boundary for the current background authorization
 * protocol. The JSON wrapper is only framing: cryptographic versioning and
 * canonical encoding remain inside the opaque bytes owned by the service.
 */
export function backgroundAuthorizationRoutes(
  app: FastifyInstance,
  service: BackgroundAuthorizationDeviceService,
): void {
  assertLimits(service.limits);
  const maximumContinuationCharacters = service.limits.continuationCharacters;
  const maximumResponseCharacters = encodedLength(service.limits.responseBytes);
  const listBodyBytes = JSON.stringify({
    requestVersion: VERSION,
    continuation: "",
  }).length + maximumContinuationCharacters;
  const respondBodyBytes = JSON.stringify({
    requestVersion: VERSION,
    responseBytesBase64url: "",
  }).length + maximumResponseCharacters;

  app.post("/api/background-authorization/requests/list", {
    ...liveShadowLargeRequestRouteOptions,
    bodyLimit: listBodyBytes,
  }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const body = request.body;
    if (
      !exactObject(body, body !== null
        && typeof body === "object"
        && "continuation" in body
        ? ["requestVersion", "continuation"]
        : ["requestVersion"])
      || body["requestVersion"] !== VERSION
      || (
        "continuation" in body
        && (
          typeof body["continuation"] !== "string"
          || body["continuation"].length < 1
          || body["continuation"].length > maximumContinuationCharacters
          || !BASE64URL.test(body["continuation"])
        )
      )
    ) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    let result: BackgroundAuthorizationDeviceListResult;
    try {
      result = await service.list(subject(request), {
        ...(typeof body["continuation"] === "string"
          ? { continuation: body["continuation"] }
          : {}),
      });
    } catch (error) {
      if (error instanceof BackgroundAuthorizationDeviceServiceError) {
        const statusCode = error.status === "malformed"
          ? 400
          : error.status === "unauthorized"
          ? 403
          : 409;
        return reply.code(statusCode).send(acknowledgement(error.status));
      }
      throw error;
    }
    if (
      result.continuation !== undefined
      && (
        result.continuation.length < 1
        || result.continuation.length > maximumContinuationCharacters
        || !BASE64URL.test(result.continuation)
      )
    ) throw new TypeError("Background authorization continuation is invalid");
    if (result.requests.length > service.limits.maximumRequests) {
      throw new TypeError("Background authorization request page is too large");
    }
    let requestPageBytes = 0;
    const requests = result.requests.map(({ requestBytes }) => {
      if (
        !(requestBytes instanceof Uint8Array)
        || requestBytes.length < 1
        || requestBytes.length > service.limits.requestBytes
      ) throw new TypeError("Background authorization request bytes are invalid");
      requestPageBytes += requestBytes.length;
      if (requestPageBytes > service.limits.requestPageBytes) {
        throw new TypeError("Background authorization request page is oversized");
      }
      return Object.freeze({
        requestBytesBase64url: Buffer.from(requestBytes).toString("base64url"),
      });
    });
    return reply.send({
      responseVersion: VERSION,
      requests,
      ...(result.continuation === undefined
        ? {}
        : { continuation: result.continuation }),
    });
  });

  app.post("/api/background-authorization/respond", {
    ...liveShadowLargeRequestRouteOptions,
    bodyLimit: respondBodyBytes,
  }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const body = request.body;
    if (
      !exactObject(body, ["requestVersion", "responseBytesBase64url"])
      || body["requestVersion"] !== VERSION
      || typeof body["responseBytesBase64url"] !== "string"
      || body["responseBytesBase64url"].length < 1
      || body["responseBytesBase64url"].length > maximumResponseCharacters
    ) return reply.code(400).send(acknowledgement("malformed"));
    const bytes = decodeCanonicalBase64url(body["responseBytesBase64url"]);
    if (
      bytes === null
      || bytes.length < 1
      || bytes.length > service.limits.responseBytes
    ) {
      bytes?.fill(0);
      return reply.code(400).send(acknowledgement("malformed"));
    }
    try {
      const result = await service.respond(subject(request), {
        responseBytes: bytes,
      });
      return reply.send(acknowledgement(result.status));
    } catch (error) {
      if (error instanceof BackgroundAuthorizationDeviceServiceError) {
        const statusCode = error.status === "malformed"
          ? 400
          : error.status === "unauthorized"
          ? 403
          : 409;
        return reply.code(statusCode).send(acknowledgement(error.status));
      }
      throw error;
    } finally {
      bytes.fill(0);
    }
  });
}
