export const REQUIRED_FIXTURE_FAMILIES = [
  "initialize",
  "thread",
  "turn",
  "steer",
  "interrupt",
  "approval",
  "request_user_input",
  "login",
  "account",
  "usage",
  "overload",
  "malformed",
  "task_report_back",
] as const;

export const REQUIRED_FIXTURE_SCENARIOS = [
  "success",
  "error",
  "cancel",
  "timeout",
] as const;

export interface ProtocolFixtureFrame {
  direction: "client_to_server" | "server_to_client" | "nautilo_internal";
  message: unknown;
}

export interface ProtocolFixture {
  id: string;
  family: (typeof REQUIRED_FIXTURE_FAMILIES)[number];
  scenario: (typeof REQUIRED_FIXTURE_SCENARIOS)[number] | "malformed" | "overload";
  frames: ProtocolFixtureFrame[];
  expected: string;
}

export interface ProtocolFixtureCorpus {
  schemaVersion: 1;
  codexVersion: string;
  fixtures: ProtocolFixture[];
}

export const FIXTURE_LIMITS = Object.freeze({
  maxFixtures: 128,
  maxFramesPerFixture: 8,
  maxFrameBytes: 64 * 1024,
  maxCorpusBytes: 1024 * 1024,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateFixtureCorpus(value: unknown): ProtocolFixtureCorpus {
  if (!isRecord(value) || value["schemaVersion"] !== 1) {
    throw new Error("Fixture corpus must use schemaVersion 1");
  }
  if (
    typeof value["codexVersion"] !== "string" ||
    !Array.isArray(value["fixtures"])
  ) {
    throw new Error("Fixture corpus is missing codexVersion or fixtures");
  }
  if (value["fixtures"].length > FIXTURE_LIMITS.maxFixtures) {
    throw new Error("Fixture corpus exceeds fixture-count limit");
  }
  if (
    Buffer.byteLength(JSON.stringify(value), "utf8") >
    FIXTURE_LIMITS.maxCorpusBytes
  ) {
    throw new Error("Fixture corpus exceeds byte limit");
  }

  const fixtures = value["fixtures"] as unknown[];
  const ids = new Set<string>();
  for (const fixture of fixtures) {
    if (
      !isRecord(fixture) ||
      typeof fixture["id"] !== "string" ||
      typeof fixture["family"] !== "string" ||
      typeof fixture["scenario"] !== "string" ||
      typeof fixture["expected"] !== "string" ||
      !Array.isArray(fixture["frames"])
    ) {
      throw new Error("Fixture entry has an invalid shape");
    }
    if (ids.has(fixture["id"])) {
      throw new Error(`Duplicate fixture id: ${fixture["id"]}`);
    }
    ids.add(fixture["id"]);
    if (fixture["frames"].length > FIXTURE_LIMITS.maxFramesPerFixture) {
      throw new Error(`Fixture ${fixture["id"]} exceeds frame-count limit`);
    }
    for (const frame of fixture["frames"]) {
      if (
        !isRecord(frame) ||
        !["client_to_server", "server_to_client", "nautilo_internal"].includes(
          String(frame["direction"]),
        ) ||
        !Object.hasOwn(frame, "message")
      ) {
        throw new Error(`Fixture ${fixture["id"]} has an invalid frame`);
      }
      if (
        Buffer.byteLength(JSON.stringify(frame["message"]), "utf8") >
        FIXTURE_LIMITS.maxFrameBytes
      ) {
        throw new Error(`Fixture ${fixture["id"]} exceeds frame-byte limit`);
      }
    }
  }

  for (const family of REQUIRED_FIXTURE_FAMILIES) {
    if (
      !fixtures.some(
        (fixture) => isRecord(fixture) && fixture["family"] === family,
      )
    ) {
      throw new Error(`Fixture corpus is missing family: ${family}`);
    }
  }
  for (const scenario of REQUIRED_FIXTURE_SCENARIOS) {
    if (
      !fixtures.some(
        (fixture) => isRecord(fixture) && fixture["scenario"] === scenario,
      )
    ) {
      throw new Error(`Fixture corpus is missing scenario: ${scenario}`);
    }
  }

  return value as unknown as ProtocolFixtureCorpus;
}
