import {
  HostedBootstrapInputError,
  runHostedBootstrapFromEnvironment,
  type HostedBootstrapEnvironment,
  type HostedBootstrapResult,
} from "./index";

type BootstrapCliOutput = HostedBootstrapResult | {
  readonly status: "failed";
  readonly clusters: readonly [];
  readonly failure: {
    readonly kind: "invalid-environment" | "internal-failure";
    readonly code?: string;
  };
};

function writeOutput(output: BootstrapCliOutput, write: (line: string) => void): void {
  // `output` is intentionally receipt-safe. Do not add exception messages,
  // connection URLs, SQL, or environment values to this JSON surface.
  write(`${JSON.stringify(output)}\n`);
}

/** Testable CLI entrypoint; returns an exit code instead of calling exit(). */
export async function main(
  environment: HostedBootstrapEnvironment = process.env,
  write: (line: string) => void = (line) => process.stdout.write(line),
): Promise<number> {
  try {
    const output = await runHostedBootstrapFromEnvironment(environment);
    writeOutput(output, write);
    return output.status === "succeeded" ? 0 : 1;
  } catch (error) {
    if (error instanceof HostedBootstrapInputError) {
      writeOutput({
        status: "failed",
        clusters: [],
        failure: { kind: "invalid-environment", code: error.code },
      }, write);
    } else {
      writeOutput({
        status: "failed",
        clusters: [],
        failure: { kind: "internal-failure" },
      }, write);
    }
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
