#!/usr/bin/env bun
/**
 * nautilo-smoke — CLI for driving security smoke tests against the
 * Lima + Tart VMs in scripts/security-test-env/.
 *
 * Companion to @nautilo/smoke-runner (library) and
 * scripts/security-test-env/ (provisioning shell scripts).
 */

import { parseArgs } from "./lib/args.ts";
import { runCommand } from "./commands/run.ts";
import { listCommand } from "./commands/list.ts";
import { statusCommand } from "./commands/status.ts";
import { snapshotCommand } from "./commands/snapshot.ts";
import { setupCommand, teardownCommand } from "./commands/shell-delegate.ts";
import { serveCommand } from "./commands/serve.ts";

const USAGE = `
nautilo-smoke — security smoke testing against disposable VMs

Commands:
  run         Execute the smoke matrix against Lima + Tart VMs.
              VMs are stopped on exit (normal or Ctrl-C); pass --keep-vms to leave them up.
              Flags: --platform=linux|macos|both (default both)
                     --mode=destructive|substitution (default destructive)
                     --level=yolo|permissive|standard|cautious|paranoid (default standard)
                     --only=<glob> (e.g. "SCAN-*", "PATH-01")
                     --layer=command-scanner|path-deny|content-scanner|...
                     --dry-run             (show scheduled tests without touching VMs)
                     --json-report=<path>  (stable-key JSON)
                     --md-report=<path>    (human-readable Markdown)
                     --keep-vms            (skip the end-of-run VM stop)

  list        Show the test catalog.
              Flags: --platform=..., --layer=..., --pattern=...

  status      Show VM health + snapshots for each configured platform.
              Flags: --platform=...

  snapshot take     <platform> <name>   Create a named snapshot.
  snapshot restore  <platform> [<name>] Restore snapshot (default: baseline).
  snapshot list     <platform>          List available snapshots.

  setup       Provision the smoke VMs. Shells out to scripts/security-test-env/setup.sh.
              Flags: --platform=linux|macos|all (default all)

  teardown    Remove the smoke VMs.
              Flags: --platform=linux|macos|all (default all)

  serve       Boot the HTTP API over the configured Runner.
              SIGINT/SIGTERM close the HTTP server then stop VMs; pass --keep-vms to leave them up.
              Flags: --host=127.0.0.1 --port=7788 --rotate-token --keep-vms
              Token stored in ~/.nautilo/smoke-token (mode 0600).

  help        Show this message.

Examples:
  nautilo-smoke setup --platform=all
  nautilo-smoke run --platform=both --level=standard
  nautilo-smoke run --only='SANDBOX-NET-*' --dry-run
  nautilo-smoke run --only='SCAN-*' --json-report=/tmp/smoke.json
  nautilo-smoke status
  nautilo-smoke snapshot restore linux baseline
  nautilo-smoke serve --port=7788
  # then from another shell / CI:
  curl -H "Authorization: Bearer $(cat ~/.nautilo/smoke-token)" \\
       http://127.0.0.1:7788/api/smoke/tests
`.trim();

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case "run":
      return runCommand(args);
    case "list":
    case "ls":
      return listCommand(args);
    case "status":
      return statusCommand(args);
    case "snapshot":
      return snapshotCommand(args);
    case "setup":
      return setupCommand(args);
    case "teardown":
      return teardownCommand(args);
    case "serve":
      return serveCommand(args);
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(USAGE);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE);
      return 64;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
