import { describe, expect, test } from "bun:test";
import corpusJson from "../../fixtures/0.146.0/protocol-corpus.json";
import inventoryJson from "../../generated/0.146.0/inventory/experimental.json";
import {
  FIXTURE_LIMITS,
  REQUIRED_FIXTURE_FAMILIES,
  REQUIRED_FIXTURE_SCENARIOS,
  validateFixtureCorpus,
} from "../../src/protocol-fixtures";

describe("protocol fixture corpus", () => {
  test("is bounded and covers every required family and outcome", () => {
    const corpus = validateFixtureCorpus(corpusJson);
    const families = new Set(corpus.fixtures.map((fixture) => fixture.family));
    const scenarios = new Set(
      corpus.fixtures.map((fixture) => fixture.scenario),
    );

    expect(families).toEqual(new Set(REQUIRED_FIXTURE_FAMILIES));
    for (const scenario of REQUIRED_FIXTURE_SCENARIOS) {
      expect(scenarios.has(scenario)).toBe(true);
    }
    expect(corpus.fixtures.length).toBeLessThanOrEqual(
      FIXTURE_LIMITS.maxFixtures,
    );
  });

  test("covers cancel and timeout where work can remain pending", () => {
    const corpus = validateFixtureCorpus(corpusJson);
    const pendingFamilies = [
      "turn",
      "approval",
      "request_user_input",
      "task_report_back",
    ];

    for (const family of pendingFamilies) {
      const scenarios = new Set(
        corpus.fixtures
          .filter((fixture) => fixture.family === family)
          .map((fixture) => fixture.scenario),
      );
      expect(scenarios.has("cancel")).toBe(true);
      expect(scenarios.has("timeout")).toBe(true);
    }
  });

  test("locks initialized ordering and the reviewed overload signal", () => {
    const corpus = validateFixtureCorpus(corpusJson);
    const initialize = corpus.fixtures.find(
      (fixture) => fixture.id === "initialize.success",
    );
    expect(initialize?.frames.at(-1)).toEqual({
      direction: "client_to_server",
      message: { method: "initialized" },
    });

    const overload = corpus.fixtures.find(
      (fixture) => fixture.id === "overload.error",
    );
    expect(overload?.frames).toEqual([
      {
        direction: "server_to_client",
        message: {
          id: 100,
          error: { code: -32001, message: "Server overloaded; retry later." },
        },
      },
    ]);
  });

  test("anchors literal transport acceptance cases to Codex 0.146.0", () => {
    const corpus = validateFixtureCorpus(corpusJson);
    expect(corpus.codexVersion).toBe("0.146.0");
    expect(JSON.stringify(corpus)).not.toContain("dynamicTools");
    expect(JSON.stringify(corpus)).not.toContain("item/tool/call");
    const transportIds = corpus.fixtures
      .filter((fixture) => fixture.id.startsWith("transport-"))
      .map((fixture) => fixture.id);
    expect(transportIds).toEqual([
      "transport-json-rpc-error",
      "transport-timeout",
      "transport-cancellation",
      "transport-eof",
      "transport-unknown-id",
      "transport-server-request",
    ]);
  });

  test("uses only methods present in the anchored protocol inventory", () => {
    const corpus = validateFixtureCorpus(corpusJson);
    const clientMethods = new Set(
      inventoryJson.entries
        .filter(
          (entry) =>
            entry.surface === "client_request" ||
            entry.surface === "client_notification",
        )
        .map((entry) => entry.name),
    );
    const serverMethods = new Set(
      inventoryJson.entries
        .filter(
          (entry) =>
            entry.surface === "server_request" ||
            entry.surface === "server_notification",
        )
        .map((entry) => entry.name),
    );

    for (const fixture of corpus.fixtures) {
      for (const frame of fixture.frames) {
        if (
          frame.message === null ||
          typeof frame.message !== "object" ||
          !("method" in frame.message) ||
          typeof frame.message.method !== "string"
        ) {
          continue;
        }
        if (frame.direction === "client_to_server") {
          expect(clientMethods.has(frame.message.method)).toBe(true);
        } else if (frame.direction === "server_to_client") {
          expect(serverMethods.has(frame.message.method)).toBe(true);
        }
      }
    }
  });

  test("rejects duplicate ids and oversized frames", () => {
    const duplicate = structuredClone(corpusJson);
    duplicate.fixtures[1]!.id = duplicate.fixtures[0]!.id;
    expect(() => validateFixtureCorpus(duplicate)).toThrow(
      "Duplicate fixture id",
    );

    const oversized = structuredClone(corpusJson);
    (
      oversized.fixtures[0]!.frames[0]! as unknown as { message: unknown }
    ).message = {
      data: "x".repeat(FIXTURE_LIMITS.maxFrameBytes + 1),
    };
    expect(() => validateFixtureCorpus(oversized)).toThrow(
      "exceeds frame-byte limit",
    );
  });
});
