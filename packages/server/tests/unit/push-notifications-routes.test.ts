import { describe, expect, test } from "bun:test";
import Fastify from "fastify";
import type {
  MobilePushInstallationRegisterRequest,
  MobilePushInstallationStatus,
} from "@nautilo/types";
import {
  PushInstallationStoreError,
  type PushInstallationStore,
} from "../../src/push/push-installation-store";
import { pushNotificationRoutes } from "../../src/routes/push-notifications";
import { SessionStore } from "../helpers/test-session-store";
import { installLocalAuthPreHandlerStub } from "./helpers/auth-preHandler-stub";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const INSTALLATION = "33333333-3333-4333-8333-333333333333";
const BINDING = "44444444-4444-4444-8444-444444444444";
const PROOF = "r".repeat(48);

function registration(
  overrides: Partial<MobilePushInstallationRegisterRequest> = {},
): MobilePushInstallationRegisterRequest {
  return {
    version: 1,
    installationId: INSTALLATION,
    bindingId: BINDING,
    platform: "ios",
    expoPushToken: "ExponentPushToken[opaque-capability-material]",
    enabled: true,
    tokenGeneration: 1,
    appVersion: "0.1.0",
    permission: "granted",
    revokeProof: PROOF,
    ...overrides,
  };
}

function status(
  state: MobilePushInstallationStatus["state"] = "active",
): MobilePushInstallationStatus {
  return {
    version: 1,
    installationId: INSTALLATION,
    bindingId: BINDING,
    platform: "ios",
    enabled: state === "active",
    tokenGeneration: 1,
    permission: state === "active" ? "granted" : "denied",
    state,
    updatedAt: "2026-08-05T20:00:00.000Z",
  };
}

function createStore() {
  let owner: string | null = null;
  let revoked = false;
  let registerCalls = 0;
  let testCalls = 0;
  let badgeEnabled = false;
  const store: PushInstallationStore = {
    async register(input) {
      registerCalls += 1;
      if (revoked) throw new PushInstallationStoreError("revoked");
      if (owner !== null && owner !== input.userId) throw new PushInstallationStoreError("not_found");
      owner = input.userId;
      if (input.request.tokenGeneration !== 1) throw new PushInstallationStoreError("stale_generation");
      return status();
    },
    async getStatus(input) {
      if (owner !== input.userId) throw new PushInstallationStoreError("not_found");
      return status(revoked ? "revoked" : "active");
    },
    async disable(input) {
      if (owner !== input.userId) throw new PushInstallationStoreError("not_found");
      if (input.request.tokenGeneration !== 1) throw new PushInstallationStoreError("stale_generation");
      return status("disabled");
    },
    async setBadgePreference(input) {
      if (owner !== input.userId) throw new PushInstallationStoreError("not_found");
      if (input.request.tokenGeneration !== 1) throw new PushInstallationStoreError("stale_generation");
      badgeEnabled = input.request.enabled;
      return input.request;
    },
    async revokeForUser(input) {
      if (owner === input.userId) revoked = true;
    },
    async revokeWithProof(input) {
      if (input.revokeProof === PROOF) revoked = true;
    },
    async enqueueGenericTest(input) {
      if (owner !== input.userId) throw new PushInstallationStoreError("not_found");
      if (revoked) throw new PushInstallationStoreError("revoked");
      testCalls += 1;
      return { notificationId: "55555555-5555-4555-8555-555555555555" };
    },
  };
  return {
    store,
    get revoked() { return revoked; },
    get registerCalls() { return registerCalls; },
    get testCalls() { return testCalls; },
    get badgeEnabled() { return badgeEnabled; },
  };
}

async function makeApp(fake = createStore()) {
  const app = Fastify();
  const sessions = new SessionStore(60_000, { persistPath: null });
  const ownerSession = sessions.createSession(OWNER, OWNER, OWNER);
  const otherSession = sessions.createSession(OTHER, OWNER, OTHER);
  installLocalAuthPreHandlerStub(app, sessions);
  pushNotificationRoutes(app, { store: fake.store });
  await app.ready();
  return {
    app,
    fake,
    ownerHeaders: { authorization: `Bearer ${ownerSession.token}` },
    otherHeaders: { authorization: `Bearer ${otherSession.token}` },
  };
}

describe("D468 push-installation routes", () => {
  test("never returns the Expo token, revoke proof, or a digest", async () => {
    const { app, ownerHeaders } = await makeApp();
    try {
      const input = registration();
      const response = await app.inject({
        method: "POST",
        url: "/api/push/installations",
        payload: input,
        headers: ownerHeaders,
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(input.expoPushToken);
      expect(response.body).not.toContain(input.revokeProof);
      expect(response.body).not.toContain("digest");
      expect(JSON.parse(response.body)).toEqual(status());
    } finally {
      await app.close();
    }
  });

  test("renders cross-owner access as the same invalid response without a binding probe", async () => {
    const { app, ownerHeaders, otherHeaders } = await makeApp();
    try {
      await app.inject({
        method: "POST",
        url: "/api/push/installations",
        payload: registration(),
        headers: ownerHeaders,
      });
      const response = await app.inject({
        method: "GET",
        url: `/api/push/installations/${BINDING}`,
        headers: otherHeaders,
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({
        error: "Invalid push installation request",
        code: "invalid_push_installation",
      });
    } finally {
      await app.close();
    }
  });

  test("maps stale token generation without accepting the late mutation", async () => {
    const { app, ownerHeaders } = await makeApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/push/installations",
        payload: registration({ tokenGeneration: 2 }),
        headers: ownerHeaders,
      });
      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body)).toMatchObject({
        code: "stale_push_token_generation",
      });
    } finally {
      await app.close();
    }
  });

  test("updates badge policy only for the owned current binding generation", async () => {
    const { app, fake, ownerHeaders, otherHeaders } = await makeApp();
    try {
      await app.inject({ method: "POST", url: "/api/push/installations", payload: registration(), headers: ownerHeaders });
      const accepted = await app.inject({
        method: "PUT",
        url: `/api/push/installations/${BINDING}/badge-preference`,
        payload: { version: 1, bindingId: BINDING, tokenGeneration: 1, enabled: true },
        headers: ownerHeaders,
      });
      expect(accepted.statusCode).toBe(200);
      expect(JSON.parse(accepted.body)).toEqual({
        version: 1,
        bindingId: BINDING,
        tokenGeneration: 1,
        enabled: true,
      });
      expect(fake.badgeEnabled).toBe(true);

      const crossOwner = await app.inject({
        method: "PUT",
        url: `/api/push/installations/${BINDING}/badge-preference`,
        payload: { version: 1, bindingId: BINDING, tokenGeneration: 1, enabled: false },
        headers: otherHeaders,
      });
      expect(crossOwner.statusCode).toBe(400);
      expect(fake.badgeEnabled).toBe(true);
    } finally {
      await app.close();
    }
  });

  test("proof cleanup is non-enumerating and a terminal revoke cannot be re-registered", async () => {
    const { app, fake, ownerHeaders } = await makeApp();
    try {
      await app.inject({
        method: "POST",
        url: "/api/push/installations",
        payload: registration(),
        headers: ownerHeaders,
      });
      const wrong = await app.inject({
        method: "POST",
        url: `/api/push/installations/${BINDING}/revoke`,
        payload: { version: 1, bindingId: BINDING, revokeProof: "w".repeat(48) },
      });
      expect(wrong.statusCode).toBe(204);
      expect(fake.revoked).toBe(false);

      const right = await app.inject({
        method: "POST",
        url: `/api/push/installations/${BINDING}/revoke`,
        payload: { version: 1, bindingId: BINDING, revokeProof: PROOF },
      });
      expect(right.statusCode).toBe(204);
      expect(fake.revoked).toBe(true);

      const resurrection = await app.inject({
        method: "POST",
        url: "/api/push/installations",
        payload: registration({ tokenGeneration: 2 }),
        headers: ownerHeaders,
      });
      expect(resurrection.statusCode).toBe(410);
      expect(JSON.parse(resurrection.body)).toMatchObject({
        code: "push_installation_revoked",
      });
    } finally {
      await app.close();
    }
  });

  test("does not claim proof cleanup succeeded when the push store is unavailable", async () => {
    const fake = createStore();
    fake.store.revokeWithProof = async () => {
      throw new PushInstallationStoreError("unavailable");
    };
    const { app } = await makeApp(fake);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/push/installations/${BINDING}/revoke`,
        payload: { version: 1, bindingId: BINDING, revokeProof: PROOF },
      });
      expect(response.statusCode).toBe(503);
      expect(JSON.parse(response.body)).toEqual({
        error: "Push delivery is temporarily unavailable",
        code: "push_unavailable",
      });
    } finally {
      await app.close();
    }
  });

  test("rejects arbitrary test copy before any fixed generic intent can be queued", async () => {
    const { app, fake, ownerHeaders } = await makeApp();
    try {
      await app.inject({
        method: "POST",
        url: "/api/push/installations",
        payload: registration(),
        headers: ownerHeaders,
      });
      const rejected = await app.inject({
        method: "POST",
        url: `/api/push/installations/${BINDING}/test`,
        payload: { version: 1, title: "steal this", body: "or this" },
        headers: ownerHeaders,
      });
      expect(rejected.statusCode).toBe(400);
      expect(fake.testCalls).toBe(0);

      const accepted = await app.inject({
        method: "POST",
        url: `/api/push/installations/${BINDING}/test`,
        payload: { version: 1 },
        headers: ownerHeaders,
      });
      expect(accepted.statusCode).toBe(200);
      expect(JSON.parse(accepted.body)).toEqual({
        accepted: true,
        notificationId: "55555555-5555-4555-8555-555555555555",
      });
      expect(fake.testCalls).toBe(1);
    } finally {
      await app.close();
    }
  });

  test("rejects unauthenticated lifecycle writes at the standard auth preHandler boundary", async () => {
    const { app, fake } = await makeApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/push/installations",
        payload: registration(),
      });
      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body)).toEqual({ error: "Unauthorized" });
      expect(fake.registerCalls).toBe(0);
    } finally {
      await app.close();
    }
  });
});
