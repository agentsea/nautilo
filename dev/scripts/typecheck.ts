import { spawn } from "bun";

// Apply defaults without POSIX parameter expansion in Bun's package-script shell.
export function typecheckEnvironment(environment: Record<string, string | undefined>) {
  const nodeOptions = environment["NODE_OPTIONS"]?.replace(/(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s+)\S+/gu, "").trim();
  return {
    ...environment,
    TURBO_CONCURRENCY: environment["TURBO_CONCURRENCY"] || "1",
    NODE_OPTIONS: [nodeOptions, "--max-old-space-size=6144"].filter(Boolean).join(" "),
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
