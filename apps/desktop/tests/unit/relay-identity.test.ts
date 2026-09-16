import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readPersistedRelayId,
  resolvePersistedRelayId,
} from "../../electron/relay-identity";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nautilo-relay-identity-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Desktop relay identity persistence", () => {
  test("is stable within one tuple and distinct across three profile directories", () => {
    const root = tempRoot();
    const generated = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ];

    const ids = generated.map((id, index) => {
      const identityFilePath = join(root, `profile-${index + 1}`, "relay-id");
      const first = resolvePersistedRelayId({ identityFilePath, uuid: () => id });
      const second = resolvePersistedRelayId({
        identityFilePath,
        uuid: () => "must-not-replace-the-persisted-id",
      });
      expect(second).toBe(first);
      expect(readFileSync(identityFilePath, "utf8")).toBe(id);
      return first;
    });

    expect(new Set(ids).size).toBe(3);
  });

  test("migrates the historical shared id only when explicitly supplied", () => {
    const root = tempRoot();
    const legacyIdentityFilePath = join(root, "legacy", "relay-id");
    const defaultIdentityFilePath = join(root, "Nautilo", "relay-id");
    const namedIdentityFilePath = join(root, "Nautilo-elias", "relay-id");
    const legacyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    mkdirSync(join(root, "legacy"), { recursive: true });
    writeFileSync(legacyIdentityFilePath, legacyId);

    const defaultId = resolvePersistedRelayId({
      identityFilePath: defaultIdentityFilePath,
      legacyIdentityFilePath,
      uuid: () => "must-not-run",
    });
    const namedId = resolvePersistedRelayId({
      identityFilePath: namedIdentityFilePath,
      uuid: () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });

    expect(defaultId).toBe(legacyId);
    expect(namedId).not.toBe(legacyId);
    expect(namedId).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });

  test("read fails closed when the tuple identity is absent", () => {
    expect(readPersistedRelayId(join(tempRoot(), "missing", "relay-id"))).toBeNull();
  });
});
