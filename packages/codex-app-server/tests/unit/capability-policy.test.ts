import { describe, expect, test } from "bun:test";
import anchorObservationJson from "../../fixtures/0.146.0/anchor-observation.json";
import experimentalInventoryJson from "../../generated/0.146.0/inventory/experimental.json";
import stableInventoryJson from "../../generated/0.146.0/inventory/stable.json";
import policyJson from "../../src/capability-policy.0.146.0.json";
import {
  CAPABILITY_FEATURE_POLICIES,
  PROTOCOL_CAPABILITY_POLICY,
  getProtocolCapabilityPolicyEntry,
  supportsCapabilityFeature,
  validateProtocolCapabilityPolicy,
} from "../../src/capability-policy";
import type { ProtocolObservation } from "../../src/compatibility-contract";
import type { ProtocolSurface } from "../../src/protocol-inventory";

function observation(): ProtocolObservation {
  return structuredClone(anchorObservationJson) as ProtocolObservation;
}

interface MutablePolicySource {
  schemaVersion: number;
  anchorId: string;
  entries: Record<ProtocolSurface, Record<string, unknown>>;
}

function policySource(): MutablePolicySource {
  return structuredClone(policyJson) as MutablePolicySource;
}

describe("protocol capability policy", () => {
  test("classifies every experimental generated member exactly once", () => {
    const generatedKeys = new Set(
      experimentalInventoryJson.entries.map((entry) => `${entry.surface}:${entry.name}`),
    );
    const policyKeys = new Set(
      PROTOCOL_CAPABILITY_POLICY.entries.map(
        (entry) => `${entry.surface}:${entry.name}`,
      ),
    );

    expect(policyKeys).toEqual(generatedKeys);
    expect(PROTOCOL_CAPABILITY_POLICY.entries).toHaveLength(
      experimentalInventoryJson.entries.length,
    );
    expect(
      new Set(PROTOCOL_CAPABILITY_POLICY.entries.map((entry) => entry.state)),
    ).toEqual(new Set(["enabled", "diagnostic", "hidden", "forbidden"]));
  });

  test("records stability separately from product treatment", () => {
    const stableKeys = new Set(
      stableInventoryJson.entries.map((entry) => `${entry.surface}:${entry.name}`),
    );
    for (const entry of PROTOCOL_CAPABILITY_POLICY.entries) {
      expect(entry.maturity).toBe(
        stableKeys.has(`${entry.surface}:${entry.name}`)
          ? "stable"
          : "experimental",
      );
    }
    expect(
      getProtocolCapabilityPolicyEntry("client_request", "process/spawn"),
    ).toMatchObject({ state: "forbidden", maturity: "experimental" });
  });

  test("fails closed on unclassified or stale generated members", () => {
    const missing = policySource();
    delete missing.entries["client_request"]["initialize"];
    expect(() => validateProtocolCapabilityPolicy(missing)).toThrow(
      "unclassified generated members: client_request:initialize",
    );

    const stale = policySource();
    stale.entries["client_request"]["future/method"] = "hidden";
    expect(() => validateProtocolCapabilityPolicy(stale)).toThrow(
      "unknown or duplicate member: client_request:future/method",
    );
  });

  test("forbids raw host process, filesystem, command, auth-token, and attestation paths", () => {
    for (const [surface, name] of [
      ["client_request", "command/exec"],
      ["client_request", "process/spawn"],
      ["client_request", "fs/writeFile"],
      ["client_request", "thread/shellCommand"],
      ["server_request", "account/chatgptAuthTokens/refresh"],
      ["server_request", "attestation/generate"],
    ] as const) {
      expect(getProtocolCapabilityPolicyEntry(surface, name)?.state).toBe("forbidden");
    }
  });
});

describe("feature gates", () => {
  test("requires reviewed native feature shapes", () => {
    const reviewed = observation();
    for (const feature of Object.keys(CAPABILITY_FEATURE_POLICIES)) {
      expect(supportsCapabilityFeature(reviewed, feature as keyof typeof CAPABILITY_FEATURE_POLICIES)).toBe(true);
    }

    const noExperimentalFlag = observation();
    delete noExperimentalFlag.fields["InitializeCapabilities.experimentalApi"];
    expect(supportsCapabilityFeature(noExperimentalFlag, "experimental_api")).toBe(false);

    const noInputRequest = observation();
    noInputRequest.members["server_request"] = (
      noInputRequest.members["server_request"] ?? []
    ).filter((member) => member !== "item/tool/requestUserInput");
    expect(supportsCapabilityFeature(noInputRequest, "request_user_input")).toBe(false);

    const changedQuestionShape = observation();
    changedQuestionShape.fields["ToolRequestUserInputQuestion.options"] = {
      required: true,
      kinds: ["array"],
    };
    expect(
      supportsCapabilityFeature(changedQuestionShape, "request_user_input"),
    ).toBe(false);

    const changedAnswerShape = observation();
    changedAnswerShape.fields["ToolRequestUserInputAnswer.answers"] = {
      required: true,
      kinds: ["string"],
    };
    expect(
      supportsCapabilityFeature(changedAnswerShape, "request_user_input"),
    ).toBe(false);

    const missingInputResponse = observation();
    missingInputResponse.members["response"] = (
      missingInputResponse.members["response"] ?? []
    ).filter((member) => member !== "ToolRequestUserInputResponse");
    expect(
      supportsCapabilityFeature(missingInputResponse, "request_user_input"),
    ).toBe(false);
  });
});
