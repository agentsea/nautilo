import { spawn } from "bun";

// Apply defaults without POSIX parameter expansion in Bun's package-script shell.
export function typecheckEnvironment(environment: Record<string, string | undefined>) {
  return {
    ...environment,
    TURBO_CONCURRENCY: environment["TURBO_CONCURRENCY"] || "1",
    NODE_OPTIONS: "--max-old-space-size=5120",
  };
}

if (import.meta.main) {
  const child = spawn(["turbo", "run", "typecheck", ...process.argv.slice(2)], {
    env: typecheckEnvironment(process.env),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await child.exited);
}
