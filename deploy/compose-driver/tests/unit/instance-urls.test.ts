import { describe, expect, test } from "bun:test";
import type { ResolvedInstance } from "@nautilo/config";
import {
  resolveLogtoAdminContainerEndpoint,
  resolveLogtoPublicUrl,
  resolveServerBaseUrl,
} from "../../src/instance-urls.ts";
import type { ComposeDriverProfile } from "../../src/types.ts";

function minimalInstance(overrides: Partial<ResolvedInstance> = {}): ResolvedInstance {
  const base: ResolvedInstance = {
    schemaVersion: 1,
    instanceId: "",
    server: { host: "localhost", port: 4001, url: "http://localhost:4001" },
    workbench: { port: 4000, url: "http://localhost:4000" },
    db: {
      directConnection: "postgresql://postgres:postgres@localhost:6434/nautilo",
      postgresHostPort: 6434,
    },
    logto: { dbPort: 6432, corePort: 4301, adminPort: 4302 },
    compose: {
      projectName: "nautilo-instance-urls-test",
      containers: {
        legacyPostgres: "nautilo-legacy-postgres-1",
        logtoPostgres: "nautilo-logto-postgres-1",
        logtoCore: "nautilo-logto-1",
        logtoSeed: "nautilo-logto-seed-1",
      },
    },
    hostname: {
      federated: "nautilo.local",
      mdns: "nautilo.local",
      tlsSan: "nautilo.local",
      caddyAuthHost: "auth.nautilo.local",
      caddyAuthAdminHost: "auth-admin.nautilo.local",
    },
  };
  return { ...base, ...overrides };
}

function localProfile(): ComposeDriverProfile {
  return {
    name: "local-default",
    transport: "local",
    lifecycle: "compose",
    from_source: true,
  };
}

function remoteProfile(
  over: Partial<ComposeDriverProfile> = {},
): ComposeDriverProfile {
  return {
    name: "remote-droplet",
    transport: "remote",
    lifecycle: "compose",
    from_source: true,
    ssh: { host: "1.2.3.4", user: "root" },
    ...over,
  };
}

describe("resolveServerBaseUrl", () => {
  test("local → http://localhost:<port>", () => {
    const inst = minimalInstance();
    expect(resolveServerBaseUrl(localProfile(), inst)).toBe(
      "http://localhost:4001",
    );
  });

  test("remote with base_url → returns it, trailing / stripped", () => {
    const inst = minimalInstance();
    expect(
      resolveServerBaseUrl(
        remoteProfile({ base_url: "http://203.0.113.7:4001/" }),
        inst,
      ),
    ).toBe("http://203.0.113.7:4001");
  });

  test("remote without base_url but with ssh.host → http://<host>:<port>", () => {
    const inst = minimalInstance();
    expect(resolveServerBaseUrl(remoteProfile(), inst)).toBe(
      "http://1.2.3.4:4001",
    );
  });

  test("remote without base_url or ssh.host → throws", () => {
    const inst = minimalInstance();
    expect(() =>
      resolveServerBaseUrl(
        remoteProfile({ ssh: undefined, base_url: undefined }),
        inst,
      ),
    ).toThrow(/has neither base_url nor ssh\.host/);
  });

  test("remote + letsencrypt + domain → https://<domain>", () => {
    const inst = minimalInstance();
    expect(
      resolveServerBaseUrl(
        remoteProfile({
          https: "letsencrypt",
          domain: "alpha.example.com",
        }),
        inst,
      ),
    ).toBe("https://alpha.example.com");
  });

  test("remote + letsencrypt without domain → falls back to plain http", () => {
    const inst = minimalInstance();
    expect(
      resolveServerBaseUrl(
        remoteProfile({ https: "letsencrypt", domain: undefined }),
        inst,
      ),
    ).toBe("http://1.2.3.4:4001");
  });
});

describe("resolveLogtoPublicUrl", () => {
  test("local → http://localhost:<corePort>", () => {
    const inst = minimalInstance();
    expect(resolveLogtoPublicUrl(localProfile(), inst)).toBe(
      "http://localhost:4301",
    );
  });

  test("remote → http://<ssh.host>:<corePort>", () => {
    const inst = minimalInstance();
    expect(resolveLogtoPublicUrl(remoteProfile(), inst)).toBe(
      "http://1.2.3.4:4301",
    );
  });

  test("remote + letsencrypt + domain → https://auth.<domain>", () => {
    const inst = minimalInstance();
    expect(
      resolveLogtoPublicUrl(
        remoteProfile({
          https: "letsencrypt",
          domain: "alpha.example.com",
        }),
        inst,
      ),
    ).toBe("https://auth.alpha.example.com");
  });
});

describe("resolveLogtoAdminContainerEndpoint", () => {
  test("always loopback on the resolved admin port", () => {
    const inst = minimalInstance();
    expect(resolveLogtoAdminContainerEndpoint(inst)).toBe(
      "http://127.0.0.1:4302",
    );
  });
});
