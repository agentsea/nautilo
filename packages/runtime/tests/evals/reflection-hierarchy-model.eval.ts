import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createEvaluationModel,
  isSupportedModelCatalogProvider,
  modelHasRunnableCredentials,
} from "@nautilo/agent/model-evaluation";
import {
  renderHierarchyModelBenchmarkReport,
  runHierarchyModelBenchmark,
  type ModelBenchmarkUsage,
} from "@nautilo/reflection/evaluation";
import { createExactHierarchyModelInvoker } from "./reflection-hierarchy-model-adapter";

export interface HierarchyModelCliOptions {
  readonly provider: string;
  readonly model: string;
  readonly runs: number;
  readonly help: boolean;
}

export function parseHierarchyModelCli(
  argv: readonly string[],
  supported: (provider: string) => boolean = isSupportedModelCatalogProvider,
): HierarchyModelCliOptions {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return { provider: "", model: "", runs: 0, help: true };
  }
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!new Set(["--provider", "--model", "--runs"]).has(flag)) {
      throw new Error("invalid_arguments");
    }
    if (values.has(flag)) throw new Error("invalid_arguments");
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--") || value.trim().length === 0) {
      throw new Error("invalid_arguments");
    }
    values.set(flag, value);
    index += 1;
  }
  const provider = values.get("--provider");
  const model = values.get("--model");
  const runsRaw = values.get("--runs");
  if (!provider || !model || !runsRaw) throw new Error("invalid_arguments");
  if (provider !== provider.toLowerCase() || !supported(provider)) {
    throw new Error("invalid_provider");
  }
  const separator = model.indexOf(":");
  if (separator < 1 || model.slice(0, separator) !== provider || separator === model.length - 1) {
    throw new Error("provider_model_mismatch");
  }
  if (!/^[1-9][0-9]*$/u.test(runsRaw)) throw new Error("invalid_runs");
  const runs = Number(runsRaw);
  if (!Number.isSafeInteger(runs) || runs > 10) throw new Error("invalid_runs");
  return { provider, model, runs, help: false };
}

export function readImplementationState(cwd: string): {
  sha: string | null;
  dirty: boolean;
} {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().length > 0;
    return { sha: sha.length > 0 ? sha : null, dirty };
  } catch {
    return { sha: null, dirty: true };
  }
}

export async function writeTransientBenchmarkReport(input: {
  readonly directory: string;
  readonly provider: string;
  readonly model: string;
  readonly report: string;
  readonly nonce?: string;
}): Promise<string> {
  const digest = createHash("sha256")
    .update(`${input.provider}\0${input.model}`)
    .digest("hex")
    .slice(0, 12);
  const nonce = input.nonce ?? `${Date.now()}-${randomUUID().slice(0, 8)}`;
  if (!/^[A-Za-z0-9-]{1,80}$/u.test(nonce)) throw new Error("invalid_output_nonce");
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  const path = resolve(input.directory, `benchmark-${digest}-${nonce}.json`);
  await writeFile(path, input.report, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return path;
}

const usageText = [
  "Usage:",
  "  bun run --cwd packages/runtime eval:reflection-hierarchy:model -- \\",
  "    --provider <provider-id> --model <exact-model-id> --runs <1-10>",
].join("\n");

export async function runHierarchyModelCli(argv: readonly string[]): Promise<number> {
  let options: HierarchyModelCliOptions;
  try {
    options = parseHierarchyModelCli(argv);
  } catch {
    process.stderr.write("[reflection-hierarchy-model] invalid_configuration\n");
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${usageText}\n`);
    return 0;
  }
  if (!modelHasRunnableCredentials(options.model)) {
    process.stderr.write("[reflection-hierarchy-model] missing_credentials\n");
    return 2;
  }

  try {
    const model = await createEvaluationModel(options.model, {
      reasoningOutput: false,
      maxTokens: 1_200,
      timeoutMs: 120_000,
    });
    const usage: ModelBenchmarkUsage[] = [];
    const implementation = readImplementationState(process.cwd());
    const report = await runHierarchyModelBenchmark({
      metadata: {
        provider: options.provider,
        model: options.model,
        runs: options.runs,
        implementationSha: implementation.sha,
        implementationDirty: implementation.dirty,
      },
      invoke: createExactHierarchyModelInvoker({ model, usage }),
      usage,
    });
    const path = await writeTransientBenchmarkReport({
      directory: resolve(import.meta.dir, ".results/reflection-hierarchy"),
      provider: options.provider,
      model: options.model,
      report: renderHierarchyModelBenchmarkReport(report),
    });
    process.stdout.write(
      `[reflection-hierarchy-model] completed structural=${report.aggregate.structuralHardGatesPassed ? "pass" : "fail"} report=${path}\n`,
    );
    return report.aggregate.structuralHardGatesPassed ? 0 : 1;
  } catch {
    process.stderr.write("[reflection-hierarchy-model] provider_invocation_failed\n");
    return 2;
  }
}

if (import.meta.main) {
  runHierarchyModelCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch(() => {
      process.stderr.write("[reflection-hierarchy-model] benchmark_failed\n");
      process.exit(2);
    });
}
