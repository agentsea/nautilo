import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  DOMAIN_KEY_BYTES_V2,
  domainKeyClassV2,
  generateDomainKeyV2,
  withDomainKeyV2,
} from "../../src/domain/domain-keys-v2.ts";

describe("M301 Domain keys V2", () => {
  test("generates independent Human and AI key material", () => {
    const crypto = new LatticeCrypto(seededRng(301_101));
    const human = generateDomainKeyV2(crypto);
    const ai = generateDomainKeyV2(crypto);

    expect(human).toHaveLength(DOMAIN_KEY_BYTES_V2);
    expect(ai).toHaveLength(DOMAIN_KEY_BYTES_V2);
    expect(human).not.toEqual(ai);
    expect(domainKeyClassV2("human")).toBe("human");
    expect(domainKeyClassV2("ai")).toBe("ai");
    expect(() => domainKeyClassV2("agent")).toThrow();

    human.fill(0);
    ai.fill(0);
  });

  test("opens only a disposable callback copy", async () => {
    const key = new Uint8Array(DOMAIN_KEY_BYTES_V2).fill(0x31);
    let opened: Uint8Array | undefined;

    await withDomainKeyV2(key, (value) => {
      opened = value;
      expect(value).not.toBe(key);
      expect(value).toEqual(key);
    });

    expect(opened).toEqual(new Uint8Array(DOMAIN_KEY_BYTES_V2));
    expect(key).toEqual(new Uint8Array(DOMAIN_KEY_BYTES_V2).fill(0x31));
    key.fill(0);
  });
});
