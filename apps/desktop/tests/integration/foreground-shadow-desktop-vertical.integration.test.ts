import { describe, expect, test } from "bun:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createElectronForegroundShadowController,
  type ElectronForegroundShadowApi,
} from "../../electron/foreground-shadow-controller";

describe("M300 Desktop foreground Shadow vertical", () => {
  test("runs the shared plaintext-only plan through main without opening custody", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-m300-desktop-vertical-"));
    const directory = join(root, "crypto-client");
    const tokens: Array<string | null> = [];
    const plans: unknown[] = [];
    const sends: unknown[] = [];
    let custodyTouches = 0;
    const unavailableAuthority = () => {
      throw new Error("plaintext-only planning must not call Domain Key V2 authority");
    };
    const api = {
      setToken: (token: string | null) => tokens.push(token),
      // The shared controller also composes Memory workflows. A plaintext
      // message must neither call those workflows nor touch device custody.
      listProtectedMemories: unavailableAuthority,
      getProtectedMemory: unavailableAuthority,
      getProtectedMemoryBrief: unavailableAuthority,
      planProtectedMemoryCreate: unavailableAuthority,
      archiveProtectedMemory: unavailableAuthority,
      transitionProtectedMemoryTier: unavailableAuthority,
      restoreProtectedMemory: unavailableAuthority,
      planProtectedMemoryAccess: unavailableAuthority,
      commitProtectedMemoryAccess: unavailableAuthority,
      planProtectedMemoryRepair: unavailableAuthority,
      commitProtectedMemoryRepair: unavailableAuthority,
      planDomainKeyAuthorityV2: unavailableAuthority,
      publishDomainKeyAuthorityV2: unavailableAuthority,
      requestDomainKeyRecipientV2: unavailableAuthority,
      listPendingDomainKeyRequestsV2: unavailableAuthority,
      fulfilDomainKeyRecipientV2: unavailableAuthority,
      fetchDomainKeyEnvelopeV2: unavailableAuthority,
      acknowledgeDomainKeyEnvelopeV2: unavailableAuthority,
      planDomainNamespaceBundleV2: unavailableAuthority,
      publishDomainNamespaceBundleV2: unavailableAuthority,
      planLiveShadowRoomMessage: (_roomId: string, request: unknown) => {
        plans.push(structuredClone(request));
        return Promise.resolve({
          responseVersion: 1 as const,
          status: "disabled" as const,
          mode: "plaintext_only" as const,
        });
      },
    } as unknown as ElectronForegroundShadowApi;
    const controller = createElectronForegroundShadowController({
      api,
      isBindingCurrent: () => true,
      refreshBearer: () => Promise.resolve("desktop-bearer"),
      sendRoomMessage: async (roomId, body) => {
        sends.push(structuredClone({ roomId, body }));
        return {
          messageId: 300,
          jobId: null,
          accepted: true,
          attachments: [],
          coalesced: false,
        };
      },
      serverScope: "https://m300.test",
      userId: "10000000-0000-4000-8000-000000000300",
      humanActorId: "20000000-0000-4000-8000-000000000300",
      installationId: "30000000-0000-4000-8000-000000000300",
      directory,
      safeStorage: {
        isEncryptionAvailable: () => {
          custodyTouches++;
          throw new Error("plaintext-only planning must not inspect custody");
        },
        encryptString: () => {
          custodyTouches++;
          throw new Error("plaintext-only planning must not encrypt custody");
        },
        decryptString: () => {
          custodyTouches++;
          throw new Error("plaintext-only planning must not decrypt custody");
        },
      },
      normalizeContent: (content) => content.trim(),
      createId: () => "operation:m300:desktop-vertical",
    });

    try {
      expect(await controller.send("room:m300", {
        content: " ordinary ",
        clientActionSessionId: "client-action:m300",
      })).toMatchObject({ messageId: 300 });
      expect(tokens).toEqual(["desktop-bearer"]);
      expect(plans).toEqual([{
        requestVersion: 2,
        idempotencyKey: "operation:m300:desktop-vertical",
        clientDeviceId: controller.deviceId,
        requestShape: "text_only",
        clientActionSessionId: "client-action:m300",
      }]);
      expect(sends).toEqual([{
        roomId: "room:m300",
        body: {
          content: " ordinary ",
          clientActionSessionId: "client-action:m300",
        },
      }]);
      expect(custodyTouches).toBe(0);
      expect(access(directory)).rejects.toThrow();
    } finally {
      await controller.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
