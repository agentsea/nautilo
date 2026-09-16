import { describe, expect, test } from "bun:test";

import { createHmacAuthorityProjectionCheckpointPort } from "../../src/server/authority-commitment";

describe("authority projection commitments", () => {
  test("uses stable keyed commitments and authenticated recoverable sealing", () => {
    const key = new Uint8Array(32).fill(0x58);
    const port = createHmacAuthorityProjectionCheckpointPort(key);
    const alternative = { humanRefs: ["a", "b"], includesPublicBoundary: true };
    expect(port.commitAlternative(alternative)).toEqual(
      port.commitAlternative({ humanRefs: ["b", "a"], includesPublicBoundary: true }),
    );
    expect(port.commitAlternative(alternative)).not.toEqual(
      createHmacAuthorityProjectionCheckpointPort(new Uint8Array(32).fill(0x59))
        .commitAlternative(alternative),
    );
    const logical = JSON.stringify({ completeAlternatives: [alternative] });
    const sealed = port.sealCheckpoint(logical);
    expect(new TextDecoder().decode(sealed)).not.toContain("humanRefs");
    expect(port.openSealedCheckpoint(sealed)).toBe(logical);
    const tampered = sealed.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(() => port.openSealedCheckpoint(tampered)).toThrow(TypeError);
  });
});
