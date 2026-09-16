import { describe, expect, test } from "bun:test";

const inboundIntentSource = await Bun.file(
  new URL("../../providers/inbound-intent.native.tsx", import.meta.url),
).text();
const scannerSource = await Bun.file(
  new URL("../../app/(onboarding)/scan-computer-qr.tsx", import.meta.url),
).text();

describe("Remote one-time verifier retention", () => {
  test("the root inbound coordinator hands pairing directly to bounded custody", () => {
    expect(inboundIntentSource).not.toContain("handled.current = raw");
    expect(inboundIntentSource).not.toContain("useRef(raw)");
    expect(inboundIntentSource).toContain("acceptRemotePairingInput(intent");
    expect(inboundIntentSource).toContain("createInboundIntentCoordinator({");
  });

  test("the scanner deduplicates by challenge ID, not raw QR data", () => {
    expect(scannerSource).not.toContain("setLastScan(data)");
    expect(scannerSource).not.toContain("useState(data)");
    expect(scannerSource).toContain(
      "setLastChallengeId(parsed.challengeId)",
    );
  });
});
