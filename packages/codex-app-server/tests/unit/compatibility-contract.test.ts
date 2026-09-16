import { describe, expect, test } from "bun:test";
import inventoryJson from "../../generated/0.146.0/inventory/experimental.json";
import alphaRequiredness from "../fixtures/0.146.0-alpha.3.1-requiredness.json";
import { createAnchorSchemaFixtureFiles } from "../../testkit/schema-fixtures";
import {
  CERTIFIED_ANCHOR_ID,
  createExecutableByteVerifier,
  CONSUMED_FIELD_REQUIREMENTS,
  DEFAULT_SCHEMA_PROBE_LIMITS,
  evaluateCompatibility,
  evaluateStableCompatibility,
  verifyExecutableBytes,
  type ProtocolObservation,
} from "../../src/compatibility-contract";
import {
  observeProtocolSchemas,
  type SchemaObservation,
} from "../../src/schema-observation";

let cachedAnchor: SchemaObservation | undefined;
function anchorEvidence(): SchemaObservation {
  if (cachedAnchor) return cachedAnchor;
  cachedAnchor = observeProtocolSchemas(
    createAnchorSchemaFixtureFiles(),
    undefined,
    null,
  );
  return cachedAnchor;
}

function anchorObservation(): ProtocolObservation {
  return structuredClone(anchorEvidence().observation);
}

describe("evaluateCompatibility", () => {
  test("checks the full reviewed stable projection without experimental-only drift", () => {
    const stable = anchorEvidence();
    expect(evaluateStableCompatibility(stable).compatible).toBe(true);

    const broken = structuredClone(stable.observation);
    broken.members["client_request"] = broken.members[
      "client_request"
    ]!.filter((member) => member !== "turn/start");
    expect(evaluateStableCompatibility(broken)).toMatchObject({
      compatible: false,
      reasons: [{ code: "missing_member", target: "client_request:turn/start" }],
    });

    const changedReviewedDifference = structuredClone(stable.observation);
    changedReviewedDifference.fields[
      "InitializeCapabilities.experimentalApi"
    ] = { required: true, kinds: ["string"] };
    expect(
      evaluateStableCompatibility(changedReviewedDifference),
    ).toMatchObject({
      compatible: false,
      reasons: [
        {
          code: "changed_field_shape",
          target: "InitializeCapabilities.experimentalApi",
        },
      ],
    });
  });

  test("incrementally verifies bytes with a one-shot lifecycle", () => {
    const bytes = new TextEncoder().encode("streamed executable");
    const verifier = createExecutableByteVerifier();
    verifier.update(bytes.subarray(0, 3));
    verifier.update(bytes.subarray(3));

    expect(verifier.finish()).toEqual(verifyExecutableBytes([bytes]));
    expect(() => verifier.finish()).toThrow("already finished");
    expect(() => verifier.update(bytes)).toThrow("already finished");
    expect(createExecutableByteVerifier().finish()).toEqual(
      verifyExecutableBytes([]),
    );
  });

  test("rejects non-byte chunks without poisoning the verifier", () => {
    const verifier = createExecutableByteVerifier();

    expect(() =>
      verifier.update("not bytes" as unknown as Uint8Array),
    ).toThrow(TypeError);
    expect(verifier.finish()).toEqual(verifyExecutableBytes([]));
  });

  test("grounds the reviewed observation in generated members and fields", () => {
    const observation = anchorObservation();
    for (const [surface, members] of Object.entries(observation.members)) {
      const generatedMembers = new Set(
        inventoryJson.entries
          .filter((entry) => entry.surface === surface)
          .map((entry) => entry.name),
      );
      for (const member of members) {
        if (
          surface === "response" &&
          (member === "JSONRPCResponse" ||
            member.endsWith("v2::LoginAccountResponse"))
        ) continue;
        expect(generatedMembers.has(member)).toBe(true);
      }
    }

    expect(new Set(Object.keys(observation.fields))).toEqual(
      new Set(CONSUMED_FIELD_REQUIREMENTS.map(({ path }) => path)),
    );
  });

  test("keeps the exact schema anchor uncertified without verified executable bytes", () => {
    const result = evaluateCompatibility(anchorEvidence());

    expect(result.state).toBe("compatible_uncertified");
    expect(result.reasons).toEqual([]);
    expect(result.features).toEqual({
      core: true,
      steer: true,
      approvals: true,
      request_user_input: true,
      collaboration_modes: true,
    });
  });

  test("never certifies caller-constructed evidence or an untrusted executable", () => {
    const bytes = new TextEncoder().encode("streamed executable");
    const whole = verifyExecutableBytes([bytes]);
    const split = verifyExecutableBytes([
      bytes.subarray(0, 8),
      bytes.subarray(8),
    ]);
    expect(split).toEqual(whole);
    expect(Object.isFrozen(whole)).toBe(true);

    const evidence = anchorEvidence();
    expect(evaluateCompatibility({
      schemaFingerprint: evidence.schemaFingerprint,
      executable: evidence.executable,
      observation: structuredClone(evidence.observation),
    }).state).toBe("compatible_uncertified");

    const untrustedExecutable = observeProtocolSchemas(
      createAnchorSchemaFixtureFiles(),
      undefined,
      verifyExecutableBytes([new TextEncoder().encode("not-codex")]),
    );
    expect(evaluateCompatibility(untrustedExecutable).state)
      .toBe("compatible_uncertified");
    expect(() => observeProtocolSchemas([{
      relativePath: "schema.json",
      bytes: new TextEncoder().encode("{}"),
    }], undefined, "sha256:caller-string" as never)).toThrow(
      "executable evidence is not verified",
    );
  });

  test("deep-freezes observed provenance before compatibility evaluation", () => {
    const evidence = anchorEvidence();
    const before = evaluateCompatibility(evidence);
    expect(Object.isFrozen(evidence.observation)).toBe(true);
    expect(Object.isFrozen(evidence.observation.members["client_request"]!))
      .toBe(true);
    expect(Object.isFrozen(evidence.observation.fields["Thread.id"]!.kinds))
      .toBe(true);
    expect(() =>
      evidence.observation.members["client_request"]!.push("poison"),
    ).toThrow();
    expect(() =>
      evidence.observation.fields["Thread.id"]!.kinds.push("boolean"),
    ).toThrow();
    expect(evaluateCompatibility(evidence)).toEqual(before);
  });

  test("accepts additive members and fields without certifying them", () => {
    const observation = anchorObservation();
    observation.members["client_request"]!.push("future/additiveMethod");
    observation.fields["ThreadStartParams.futureOptionalField"] = {
      required: false,
      kinds: ["string"],
    };

    expect(evaluateCompatibility(observation).state).toBe(
      "compatible_uncertified",
    );
  });

  test("rejects a missing required core method", () => {
    const observation = anchorObservation();
    observation.members["client_request"] =
      observation.members["client_request"]!.filter(
        (member) => member !== "turn/start",
      );

    const result = evaluateCompatibility(observation);
    expect(result.state).toBe("incompatible");
    expect(result.reasons).toContainEqual({
      feature: "core",
      code: "missing_member",
      target: "client_request:turn/start",
    });
  });

  test("rejects a changed required discriminator field type", () => {
    const observation = anchorObservation();
    observation.fields["TurnStartParams.threadId"] = {
      required: true,
      kinds: ["number"],
    };

    const result = evaluateCompatibility(observation);
    expect(result.state).toBe("incompatible");
    expect(result.reasons).toContainEqual({
      feature: "core",
      code: "changed_field_shape",
      target: "TurnStartParams.threadId",
    });
  });

  test("accepts runtime broadening of an outbound consumed field type", () => {
    const observation = anchorObservation();
    observation.fields["TurnStartParams.threadId"] = {
      required: true,
      kinds: ["number", "string"],
    };

    expect(evaluateCompatibility(observation).state).toBe(
      "compatible_uncertified",
    );
  });

  test("accepts reviewed enum additions emitted by the official 0.146.0 x64 build", () => {
    const observation = anchorObservation();
    for (const path of [
      "ChatgptAccount.planType",
      "RateLimitSnapshot.planType",
      "AccountUpdatedNotification.planType",
    ]) {
      observation.fields[path]!.literals = [
        ...observation.fields[path]!.literals!,
        "ent26",
      ];
    }
    observation.fields["AccountUpdatedNotification.authMode"]!.literals = [
      ...observation.fields["AccountUpdatedNotification.authMode"]!.literals!,
      "bedrockApiKey",
      "headers",
    ];

    expect(evaluateStableCompatibility(observation).compatible).toBe(true);
    expect(evaluateCompatibility(observation).features.core).toBe(true);
  });

  test("fails core for drift in every representative consumed projection family", () => {
    const paths = [
      "Thread.id",
      "TurnCompletedNotification.turn",
      "Model.id",
      "ChatgptAccount.email",
      "RateLimitSnapshot.primary",
      "GetAccountTokenUsageResponse.summary",
      "AgentMessageDeltaNotification.delta",
      "ActiveThreadStatus.activeFlags",
      "FileUpdateChange.diff",
      "UpdatePatchChangeKind.move_path",
      "Chatgptv2::LoginAccountResponse.authUrl",
      "HookPromptFragment.text",
    ];
    for (const path of paths) {
      const observation = anchorObservation();
      observation.fields[path] = { required: true, kinds: ["boolean"] };
      const result = evaluateCompatibility(observation);
      expect(result.features.core).toBe(false);
      expect(result.reasons.some((reason) => reason.target === path)).toBe(true);
    }
  });

  test("fails core when a runtime-owned enum adds a value Nautilo cannot decode", () => {
    const observation = anchorObservation();
    observation.fields["ActiveThreadStatus.activeFlags"] = {
      required: true,
      kinds: ["array"],
      literals: ["waitingOnApproval", "waitingOnUserInput", "futureFlag"],
    };
    const result = evaluateCompatibility(observation);
    expect(result.features.core).toBe(false);
    expect(result.reasons).toContainEqual({
      feature: "core",
      code: "changed_field_shape",
      target: "ActiveThreadStatus.activeFlags",
    });
  });

  test("gates approvals independently when a consumed decision disappears", () => {
    const observation = anchorObservation();
    observation.fields["FileChangeRequestApprovalResponse.decision"]!.literals =
      ["accept", "acceptForSession", "decline"];
    const result = evaluateCompatibility(observation);
    expect(result.state).toBe("limited");
    expect(result.features.approvals).toBe(false);
    expect(result.features.core).toBe(true);
  });

  test("limits only native request input when its projection is missing", () => {
    const observation = anchorObservation();
    observation.members["server_request"] =
      observation.members["server_request"]!.filter(
        (member) => member !== "item/tool/requestUserInput",
      );

    const result = evaluateCompatibility(observation);
    expect(result.state).toBe("limited");
    expect(result.features.core).toBe(true);
    expect(result.features.request_user_input).toBe(false);
  });

  test("limits native request input when nested question or answer shapes drift", () => {
    const changedQuestion = anchorObservation();
    changedQuestion.fields["ToolRequestUserInputQuestion.options"] = {
      required: false,
      kinds: ["array"],
    };
    const questionResult = evaluateCompatibility(changedQuestion);
    expect(questionResult.state).toBe("limited");
    expect(questionResult.features.request_user_input).toBe(false);

    const changedAnswer = anchorObservation();
    changedAnswer.fields["ToolRequestUserInputAnswer.answers"] = {
      required: true,
      kinds: ["string"],
    };
    const answerResult = evaluateCompatibility(changedAnswer);
    expect(answerResult.state).toBe("limited");
    expect(answerResult.features.request_user_input).toBe(false);
  });

  test("classifies the observed 0.146.0-alpha.3.1 requiredness drift by wire direction", () => {
    const observation = anchorObservation();
    for (const [path, required] of Object.entries(alphaRequiredness)) {
      observation.fields[path] = {
        ...observation.fields[path]!,
        required,
      };
    }

    expect(Object.fromEntries(
      CONSUMED_FIELD_REQUIREMENTS
        .filter(({ path }) => Object.hasOwn(alphaRequiredness, path))
        .map(({ path, direction }) => [path, direction]),
    )).toEqual({
      "InitializeCapabilities.experimentalApi": "nautilo_to_runtime",
      "ToolRequestUserInputQuestion.isOther": "runtime_to_nautilo",
      "ToolRequestUserInputQuestion.isSecret": "runtime_to_nautilo",
      "ToolRequestUserInputQuestion.options": "runtime_to_nautilo",
      "CommandExecutionRequestApprovalParams.startedAtMs": "runtime_to_nautilo",
      "FileChangeRequestApprovalParams.startedAtMs": "runtime_to_nautilo",
      "PermissionsRequestApprovalParams.startedAtMs": "runtime_to_nautilo",
      "TurnSteerResponse.turnId": "runtime_to_nautilo",
      "ChatgptDeviceCodev2::LoginAccountResponse.loginId": "runtime_to_nautilo",
    });

    const result = evaluateCompatibility(observation);
    expect(result.state).toBe("limited");
    expect(result.features).toEqual({
      core: true,
      steer: true,
      approvals: true,
      request_user_input: false,
      collaboration_modes: true,
    });
    expect(result.reasons).toEqual([
      {
        feature: "request_user_input",
        code: "changed_field_shape",
        target: "ToolRequestUserInputQuestion.isOther",
      },
      {
        feature: "request_user_input",
        code: "changed_field_shape",
        target: "ToolRequestUserInputQuestion.isSecret",
      },
      {
        feature: "request_user_input",
        code: "changed_field_shape",
        target: "ToolRequestUserInputQuestion.options",
      },
    ]);
  });
});

describe("schema probe limits", () => {
  test("are bounded and large enough for the reviewed anchor", () => {
    expect(CERTIFIED_ANCHOR_ID).toBe("codex-app-server@0.146.0");
    expect(DEFAULT_SCHEMA_PROBE_LIMITS).toEqual({
      timeoutMs: 5_000,
      maxFiles: 4_096,
      maxTotalBytes: 33_554_432,
      maxFileBytes: 8_388_608,
      maxJsonDepth: 128,
      maxJsonNodes: 1_000_000,
    });
  });
});
