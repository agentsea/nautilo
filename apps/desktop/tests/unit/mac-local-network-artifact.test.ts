import { describe, expect, test } from "bun:test";
import {
  EXPECTED_BONJOUR_SERVICES,
  EXPECTED_BUNDLE_ID,
  EXPECTED_LOCAL_NETWORK_USAGE,
  classifyMacSignatureDetails,
  validateMacLocalNetworkInfo,
} from "../../scripts/inspect-macos-local-network-artifact";

describe("packaged macOS Local Network evidence", () => {
  test("accepts only the final bundle identity and exact picker-scoped declaration", () => {
    expect(validateMacLocalNetworkInfo({
      CFBundleIdentifier: EXPECTED_BUNDLE_ID,
      CFBundleExecutable: "Nautilo",
      NSLocalNetworkUsageDescription: EXPECTED_LOCAL_NETWORK_USAGE,
      NSBonjourServices: [...EXPECTED_BONJOUR_SERVICES],
    })).toEqual({
      bundleId: EXPECTED_BUNDLE_ID,
      localNetworkUsageDescription: EXPECTED_LOCAL_NETWORK_USAGE,
      bonjourServices: [...EXPECTED_BONJOUR_SERVICES],
      bundleExecutable: "Nautilo",
    });
    expect(() => validateMacLocalNetworkInfo({
      CFBundleIdentifier: EXPECTED_BUNDLE_ID,
      CFBundleExecutable: "Nautilo",
      NSLocalNetworkUsageDescription: "Browse the network",
      NSBonjourServices: [...EXPECTED_BONJOUR_SERVICES],
    })).toThrow("canonical picker-scoped purpose string");
    expect(() => validateMacLocalNetworkInfo({
      CFBundleIdentifier: EXPECTED_BUNDLE_ID,
      CFBundleExecutable: "Nautilo",
      NSLocalNetworkUsageDescription: EXPECTED_LOCAL_NETWORK_USAGE,
      NSBonjourServices: ["_nautilo._tcp", "_http._tcp"],
    })).toThrow("exactly _nautilo._tcp");
    expect(() => validateMacLocalNetworkInfo({
      CFBundleIdentifier: "com.example.nautilo-test",
      CFBundleExecutable: "Nautilo",
      NSLocalNetworkUsageDescription: EXPECTED_LOCAL_NETWORK_USAGE,
      NSBonjourServices: [...EXPECTED_BONJOUR_SERVICES],
    })).toThrow(`CFBundleIdentifier must be ${EXPECTED_BUNDLE_ID}`);
  });

  test("reports unsigned, ad-hoc, Developer ID, and unknown signature modes without signer names", () => {
    expect(classifyMacSignatureDetails(1, "code object is not signed at all")).toEqual({
      signatureMode: "unsigned",
      signatureIdentifier: null,
      teamIdentifier: null,
      cdHash: null,
    });
    expect(classifyMacSignatureDetails(
      0,
      "Identifier=com.nautilo.desktop\nSignature=adhoc\nTeamIdentifier=not set\nCDHash=AABBCC",
    )).toEqual({
      signatureMode: "adhoc",
      signatureIdentifier: "com.nautilo.desktop",
      teamIdentifier: null,
      cdHash: "aabbcc",
    });
    expect(classifyMacSignatureDetails(
      0,
      "Identifier=com.nautilo.desktop\nAuthority=Developer ID Application: Example Corp (ABCDEFGHIJ)\nTeamIdentifier=ABCDEFGHIJ\nCDHash=DDEEFF",
    )).toEqual({
      signatureMode: "developer-id",
      signatureIdentifier: "com.nautilo.desktop",
      teamIdentifier: "ABCDEFGHIJ",
      cdHash: "ddeeff",
    });
    expect(classifyMacSignatureDetails(
      0,
      "Identifier=com.nautilo.desktop\nAuthority=Apple Development: Person\nTeamIdentifier=ABCDEFGHIJ\nCDHash=112233",
    )).toEqual({
      signatureMode: "other",
      signatureIdentifier: "com.nautilo.desktop",
      teamIdentifier: "ABCDEFGHIJ",
      cdHash: "112233",
    });
  });
});
