import { describe, expect, test } from "bun:test";

import {
  createRailwayExecutor,
  createRailwayStdinTokenSource,
  RailwayCliGraphqlExecutor,
  RailwayExecutor,
  railwayMe,
  railwayProjectCreate,
  type RailwayCliInvocation,
  type RailwayCliRunner,
  type RailwayExecutorTransport,
  type RailwayGraphqlVariables,
  type RailwayOperation,
  type RailwayOperationData,
  type RailwayOperationVariables,
  type RailwayTransportResult,
} from "../../src";

const metadata = { httpStatus: 200, rateLimit: {} } as const;
const qualifiedVersionProbe = { async probe() { return "5.30.4"; } } as const;

class FixtureTransport implements RailwayExecutorTransport {
  readonly calls: string[] = [];

  constructor(private readonly result: RailwayTransportResult<unknown>) {}

  async execute<Operation extends RailwayOperation<string, RailwayGraphqlVariables, unknown>>(
    operation: Operation,
    _variables: RailwayOperationVariables<Operation>,
  ): Promise<RailwayTransportResult<RailwayOperationData<Operation>>> {
    this.calls.push(operation.name);
    return this.result as RailwayTransportResult<RailwayOperationData<Operation>>;
  }
}

function successCliRunner(
  calls: RailwayCliInvocation[],
  payload: unknown = { data: { me: { id: "user-1", name: "Taylor", workspaces: [] } } },
): RailwayCliRunner {
  return {
    async run(input) {
      calls.push(input);
      return { outcome: "success", stdout: JSON.stringify(payload) };
    },
  };
}

describe("RailwayExecutor", () => {
  test("uses direct bearer GraphQL by default and invokes the pinned CLI JSON path only after a failed query", async () => {
    const cliCalls: RailwayCliInvocation[] = [];
    const executor = createRailwayExecutor({
      accessToken: "native-access-token-not-for-cli",
      fetch: async () => new Response("expired native bearer", { status: 401 }),
      cliFallback: { binary: "railway-test", runner: successCliRunner(cliCalls), versionProbe: qualifiedVersionProbe },
    });

    const result = await executor.execute(railwayMe, {});

    expect(result).toEqual({
      outcome: "success",
      data: { me: { id: "user-1", name: "Taylor", workspaces: [] } },
      metadata,
    });
    expect(cliCalls).toHaveLength(1);
    const { signal: _signal, ...apiInvocation } = cliCalls[0]!;
    expect(apiInvocation).toEqual({
      binary: "railway-test",
      args: [
        "api",
        railwayMe.document,
        "--operation-name",
        "RailwayMe",
        "--variables",
        "@-",
        "--compact",
        "--allow-errors",
      ],
      stdin: "{}",
    });
    expect(JSON.stringify(cliCalls[0])).not.toContain("native-access-token-not-for-cli");
  });

  test("never retries a mutation through a fallback because the direct request may have reached Railway", async () => {
    const direct = new FixtureTransport({
      outcome: "failure",
      failure: { kind: "network-failure", operation: "RailwayProjectCreate" },
    });
    const fallback = new FixtureTransport({
      outcome: "success",
      data: { projectCreate: { id: "project-1", name: "nautilo" } },
      metadata,
    });
    const executor = new RailwayExecutor({ direct, fallbacks: [fallback] });

    const result = await executor.execute(railwayProjectCreate, { input: { name: "nautilo" } });

    expect(result.outcome).toBe("failure");
    expect(direct.calls).toEqual(["RailwayProjectCreate"]);
    expect(fallback.calls).toEqual([]);
  });

  test("does not turn rate limits or arbitrary direct transport failures into automatic retries", async () => {
    const fallback = new FixtureTransport({
      outcome: "success",
      data: { me: { id: "user-1", name: "Taylor", workspaces: [] } },
      metadata,
    });

    for (const kind of ["rate-limited", "network-failure", "invalid-response"] as const) {
      const direct = new FixtureTransport({
        outcome: "failure",
        failure: { kind, operation: "RailwayMe" },
      });
      const executor = new RailwayExecutor({ direct, fallbacks: [fallback] });
      expect((await executor.execute(railwayMe, {})).outcome).toBe("failure");
    }

    expect(fallback.calls).toEqual([]);
  });

  test("fails closed on CLI prose and preserves only the existing redacted GraphQL error summary", async () => {
    const prose = new RailwayCliGraphqlExecutor({
      runner: { async run() { return { outcome: "success", stdout: "CLI says secret=not-safe" }; } },
      versionProbe: qualifiedVersionProbe,
    });
    const proseResult = await prose.execute(railwayMe, {});
    expect(proseResult).toEqual({
      outcome: "failure",
      failure: { kind: "invalid-response", operation: "RailwayMe", httpStatus: 200 },
      metadata,
    });
    expect(JSON.stringify(proseResult)).not.toContain("secret=not-safe");

    const graphql = new RailwayCliGraphqlExecutor({
      runner: successCliRunner([], {
        data: { me: { id: "user-1", name: "Taylor", workspaces: [] } },
        errors: [{ message: "provider secret must not escape" }],
      }),
      versionProbe: qualifiedVersionProbe,
    });
    const graphqlResult = await graphql.execute(railwayMe, {});
    expect(graphqlResult).toEqual({
      outcome: "partial",
      data: { me: { id: "user-1", name: "Taylor", workspaces: [] } },
      failure: {
        kind: "graphql-error",
        operation: "RailwayMe",
        httpStatus: 200,
        graphql: { kind: "graphql-error", count: 1 },
      },
      metadata,
    });
    expect(JSON.stringify(graphqlResult)).not.toContain("provider secret must not escape");
  });

  test("fails closed before a CLI API call when its version is not qualified", async () => {
    const calls: RailwayCliInvocation[] = [];
    const executor = new RailwayCliGraphqlExecutor({
      runner: successCliRunner(calls),
      versionProbe: { async probe() { return "5.30.3"; } },
    });

    const result = await executor.execute(railwayMe, {});

    expect(result).toEqual({
      outcome: "failure",
      failure: { kind: "network-failure", operation: "RailwayMe" },
    });
    expect(calls).toEqual([]);
  });

  test("uses an explicitly injected qualification policy for a separately approved CLI version", async () => {
    const calls: RailwayCliInvocation[] = [];
    const executor = new RailwayCliGraphqlExecutor({
      runner: successCliRunner(calls),
      versionProbe: { async probe() { return "5.30.5"; } },
      versionPolicy: { accepts(version) { return version === "5.30.5"; } },
    });

    expect((await executor.execute(railwayMe, {})).outcome).toBe("success");
    expect(calls).toHaveLength(1);
  });

  test("aborts a hung CLI invocation at its bounded timeout", async () => {
    let aborted = false;
    const executor = new RailwayCliGraphqlExecutor({
      timeoutMs: 5,
      versionProbe: qualifiedVersionProbe,
      runner: {
        run(input) {
          return new Promise((resolve) => {
            input.signal?.addEventListener("abort", () => {
              aborted = true;
              resolve({ outcome: "failure" });
            }, { once: true });
          });
        },
      },
    });

    expect((await executor.execute(railwayMe, {})).outcome).toBe("failure");
    expect(aborted).toBe(true);
  });

  test("fails over native bearer, then CLI session, then a stdin-injected explicit token without leaking it", async () => {
    const sessionCalls: RailwayCliInvocation[] = [];
    const tokenCalls: RailwayCliInvocation[] = [];
    const explicitToken = "explicit-ci-token-not-for-argv";
    async function* stdin(): AsyncIterable<Uint8Array | string> {
      yield `${explicitToken}\n`;
    }

    const executor = createRailwayExecutor({
      accessToken: "native-access-token-not-for-cli",
      fetch: async () => new Response("expired native bearer", { status: 401 }),
      cliFallback: {
        runner: {
          async run(input) {
            sessionCalls.push(input);
            return { outcome: "failure" };
          },
        },
        versionProbe: qualifiedVersionProbe,
      },
      explicitTokenFallback: {
        tokenSource: createRailwayStdinTokenSource(stdin()),
        runner: successCliRunner(tokenCalls),
        versionProbe: qualifiedVersionProbe,
      },
    });

    const result = await executor.execute(railwayMe, {});

    expect(result.outcome).toBe("success");
    expect(sessionCalls).toHaveLength(1);
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.environment).toEqual({
      RAILWAY_API_TOKEN: explicitToken,
      RAILWAY_TOKEN: undefined,
    });
    expect(tokenCalls[0]?.args.join(" ")).not.toContain(explicitToken);
    expect(tokenCalls[0]?.stdin).not.toContain(explicitToken);
    expect(JSON.stringify(result)).not.toContain(explicitToken);
  });

  test("accepts a single newline-terminated stdin token and rejects a second record", async () => {
    async function* valid(): AsyncIterable<Uint8Array | string> {
      yield "one-token\r\n";
    }
    async function* invalid(): AsyncIterable<Uint8Array | string> {
      yield "one-token\nsecond-token\n";
    }

    const validSource = createRailwayStdinTokenSource(valid());
    expect(await validSource.readToken()).toBe("one-token");
    expect(await validSource.readToken()).toBeUndefined();
    expect(await createRailwayStdinTokenSource(invalid()).readToken()).toBeUndefined();
  });
});
