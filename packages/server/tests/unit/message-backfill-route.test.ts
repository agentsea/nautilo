import { describe, expect, test } from "bun:test";
import Fastify from "fastify";

import {
  MAX_ENCRYPTED_PAYLOAD_WIRE_BYTES_V2,
  MAX_HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_WIRE_BYTES_V1,
  MAX_NAMESPACE_OBJECT_ENVELOPE_WIRE_BYTES_V2,
  MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5,
} from "@nautilo/lattice-crypto/wire-limits";
import { messageBackfillRoutes } from "../../src/routes/message-backfill";

const USER = "31000000-0000-4000-8000-000000000001";
const HUMAN = "31000000-0000-4000-8000-000000000002";
const CLAIM = "31000000-0000-4000-8000-000000000003";

const publicationBodyBytes = JSON.stringify({
  claimId: "00000000-0000-4000-8000-000000000000",
  requestBytesBase64url: "",
  payloadBytesBase64url: "",
  manifestBytesBase64url: "",
  envelopeBytesBase64url: "",
}).length + [
  MAX_HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_WIRE_BYTES_V1,
  MAX_ENCRYPTED_PAYLOAD_WIRE_BYTES_V2,
  MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5,
  MAX_NAMESPACE_OBJECT_ENVELOPE_WIRE_BYTES_V2,
].reduce((total, bytes) => total + Math.ceil(bytes * 4 / 3), 0);

function appWithPublish(onPublish: () => void) {
  const app = Fastify();
  app.decorateRequest("sessionUserId", null);
  app.decorateRequest("sessionActorId", null);
  app.decorateRequest("cryptoDeviceAdmission", null);
  app.addHook("preHandler", (request, _reply, done) => {
    if (request.headers.authorization === "Bearer ok") {
      request.sessionUserId = USER;
      request.sessionActorId = HUMAN;
      request.cryptoDeviceAdmission = {
        deviceId: "device-m313",
        deviceGeneration: 1,
        serverInstanceId: "server-m313",
        lineageGeneration: 0,
        epoch: 1,
        securityRevision: 1,
        headDigest: new Uint8Array(32),
        expiresAt: Date.now() + 60_000,
      };
    }
    done();
  });
  messageBackfillRoutes(app, {
    next: () => Promise.resolve({
      status: "disabled", resumeAt: null, snapshotAt: 0, complete: false,
    }),
    source: () => Promise.resolve({ status: "stale", resumeAt: 0 }),
    publish: () => {
      onPublish();
      return Promise.resolve({ status: "published" });
    },
    ack: () => Promise.resolve({ status: "stale", resumeAt: 0 }),
    progress: () => Promise.resolve({
      status: "disabled", snapshotAt: 0, snapshotComplete: true,
      caughtUp: true, lastSweepAt: null, activeLease: false,
      counts: {eligible: 0, alreadyAuthenticated: 0,
        independentlyParityVerified: 0, claimedRepairing: 0,
        repairedAndVerified: 0, unsupported: 0, failed: 0},
      waiting: {authorizedDevice: 0, authority: 0},
    }),
  });
  return app;
}

describe("Message backfill route body boundary", () => {
  test("checks bearer structure before parsing and admits the codec-sized publication", async () => {
    let publishCalls = 0;
    const app = appWithPublish(() => { publishCalls += 1; });
    for (const authorization of [undefined, "Basic no", "Bearer two tokens"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/message-backfill/publish",
        headers: {
          "content-type": "application/json",
          ...(authorization === undefined ? {} : { authorization }),
        },
        payload: "{",
      });
      expect(response.statusCode).toBe(401);
    }

    const aboveFastifyDefault = await app.inject({
      method: "POST",
      url: "/api/message-backfill/publish",
      headers: {
        authorization: "Bearer ok",
        "content-type": "application/json",
      },
      payload: {
        claimId: CLAIM,
        requestBytesBase64url: "AQ",
        payloadBytesBase64url: "A".repeat(1_100_000),
        manifestBytesBase64url: "AQ",
        envelopeBytesBase64url: "AQ",
      },
    });
    expect(aboveFastifyDefault.statusCode).toBe(200);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/message-backfill/publish",
      headers: {
        authorization: "Bearer ok",
        "content-type": "application/json",
        "content-length": String(publicationBodyBytes + 1),
      },
      payload: "{}",
    });
    expect(oversized.statusCode).toBe(413);
    expect(publishCalls).toBe(1);
    await app.close();
  });
});
