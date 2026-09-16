import { describe, expect, test } from "bun:test";
import {
  ApiError,
  type NautiloApiClient,
} from "@nautilo/api-client/browser";
import {
  runSameServerRemoteRequest,
  type RemoteServerTarget,
} from "./remote-request";

const target: RemoteServerTarget = {
  id: "srv_exact",
  serverUrl: "https://exact.example",
  displayName: "Exact",
};

describe("same-server remote requests", () => {
  test("a stale bearer refreshes and retries only the captured server", async () => {
    let attempts = 0;
    const tokens: Array<string | null> = [];
    const client = {
      setToken: (token: string | null) => {
        tokens.push(token);
      },
    } as unknown as NautiloApiClient;
    const calls: string[] = [];
    const result = await runSameServerRemoteRequest(
      target,
      async (received) => {
        expect(received).toBe(client);
        attempts += 1;
        if (attempts === 1) throw new ApiError(401, "stale");
        return "ok";
      },
      {
        getClient: (serverUrl) => {
          calls.push(`client:${serverUrl}`);
          return client;
        },
        refreshToken: async (serverId, serverUrl) => {
          calls.push(`refresh:${serverId}:${serverUrl}`);
          return "fresh-token";
        },
        authDead: (serverId) => calls.push(`dead:${serverId}`),
      },
    );
    expect(result).toBe("ok");
    expect(tokens).toEqual(["fresh-token"]);
    expect(calls).toEqual([
      "client:https://exact.example",
      "refresh:srv_exact:https://exact.example",
    ]);
  });

  test("a dead refresh reports only the captured server and does not retry", async () => {
    let attempts = 0;
    const dead: string[] = [];
    let rejection: unknown;
    try {
      await runSameServerRemoteRequest(
        target,
        async () => {
          attempts += 1;
          throw new ApiError(401, "stale");
        },
        {
          getClient: () =>
            ({ setToken: () => {} }) as unknown as NautiloApiClient,
          refreshToken: async () => null,
          authDead: (serverId) => dead.push(serverId),
        },
      );
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(ApiError);
    expect(attempts).toBe(1);
    expect(dead).toEqual(["srv_exact"]);
  });
});
