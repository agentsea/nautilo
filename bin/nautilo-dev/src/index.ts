import { save } from "./commands/save";
import type { SaveBackupMode } from "./commands/save";
import { restore } from "./commands/restore";
import { clean } from "./commands/clean";
import { cleanupInstancesCmd } from "./commands/cleanup-instances";
import { nukeClientCacheCmd } from "./commands/nuke-client-cache";
import { list } from "./commands/list";
import { preflightCmd } from "./commands/preflight";
import { inspectCmd } from "./commands/inspect";
import { verifyCmd } from "./commands/verify";
import { verifyPostgresDatabases } from "./commands/verify-postgres-databases";
import { infraStart } from "./commands/infra-start";
import { infraStop } from "./commands/infra-stop";
import { infraStatus } from "./commands/infra-status";
import { migrateToLogto } from "./commands/migrate-to-logto";
import { migrateFromLogto } from "./commands/migrate-from-logto";
import { migrateArtifacts } from "./commands/migrate-artifacts";
import { verifyUserLink } from "./commands/verify-user-link";
import { migrateToUsernameIdentity } from "./commands/migrate-to-username-identity";
import { migrateAddAgentRole } from "./commands/migrate-add-agent-role";
import { upgrade } from "./commands/upgrade";
import { verifyConfigEnv } from "./commands/verify-config-env";
import { verifyPoolLifecycleCmd } from "./commands/verify-pool-lifecycle";
import { resetLogtoAdminPassword } from "./commands/reset-logto-admin-password";
import { repairLogtoAccountSecurity } from "./commands/repair-logto-account-security";
import { repairOrphanDefaultAgent } from "./commands/repair-orphan-default-agent";
import { markAllMessagesRead } from "./commands/mark-all-messages-read";
import { cleanupTestCruft } from "./commands/cleanup-test-cruft";
import { resetTestCruft } from "./commands/reset-test-cruft";
import { resetLogtoUserPassword } from "./commands/reset-logto-user-password";
import { listInstancesCmd } from "./commands/list-instances";
import { deleteInstance } from "./commands/delete-instance";
import { protectInstance } from "./commands/protect-instance";
import { devStackCmd } from "./commands/dev-stack";
import { qualifyOwnerClaimCmd } from "./commands/qualify-owner-claim";
import { qualifyPackagedTargetCmd } from "./commands/qualify-packaged-target";
import { officeCmd } from "./commands/office";
import { mcpCmd } from "./commands/mcp";
import { setupStatusCmd } from "./commands/setup-status";
import { memoryPromoteCmd } from "./commands/memory-promote";
import { setupInstanceCmd } from "./commands/setup-instance";
import { genSetupTemplateCmd } from "./commands/gen-setup-template";
import { mintUser } from "./commands/mint-user";
import { serverStart } from "./commands/server-start";
import { serverStop } from "./commands/server-stop";
import { serverStatus } from "./commands/server-status";
import { serverRestart } from "./commands/server-restart";
import { cloneDevInstance } from "./commands/clone";
import { compactCheckpointsCmd } from "./commands/compact-checkpoints";
import { applyInstanceArgFromArgv, stripInstancePairFromArgv } from "@nautilo/config";

/**
 * Argv-time list of "value flags" — flags that consume the next argv as
 * their value (e.g. `--container <name>`). Both `flagValue` and the
 * `positional()` skip-list consult this so the helpers stay in sync.
 */
const VALUE_FLAGS = new Set([
  "--container",
  "--instance",
  "--output",
  "--output-dir",
  "--config-env",
  "--email",
  "--handle",
  "--user-id",
  "--mark-complete",
  "--out",
  "--seed",
  "--password-env",
  "--claim-code",
  "--claim-env",
  "--limit",
  "--display-name",
  "--provider",
  "--agent-id",
  "--namespace-id",
  "--password",
  "--pin",
  "--id",
  "--query",
  "--top",
  "--server",
  "--owner-config",
  "--target-instance",
  "--config",
  "--env-file",
  "--keep-agent-id",
  "--keep-user-id",
  "--orphan-agent-id",
  "--orphan-user-id",
  "--keep-user-handles",
  "--keep-user-ids",
  "--allow-fixture-user-ids",
  "--fixture-plan",
  "--approve-plan",
  "--max-deletions",
  "--plan-out",
  "--mode",
  "--from",
  "--to",
  "--run-id",
]);

const USAGE = `
nautilo-dev — snapshot/restore local development state

Commands:
  save <name> [flags]               Snapshot database, instance.env, and ~/.nautilo
                                    flags: --mode dump|basebackup, --require-logto
  clone [flags]                     Clone a complete backup of one named dev instance
                                    into a wholly absent named target, then apply this
                                    checkout's migrations to the populated copy.
                                    flags: --from <id> --to <id>
  compact-checkpoints [flags]       D489: dry-run checkpoint inventory for default
                                    or named instances. --apply is backup-gated,
                                    canonical-default-only, and requires the
                                    explicit danger acknowledgement.
                                    flags: --instance <default|name>, --json,
                                           --apply, --reclaim-physical,
                                           --i-know-what-i-am-doing
  restore <name> [flags]            Restore a named snapshot
                                    flags: --no-autosave
  preflight <name>                  Dry-run a restore; show what would / would not
                                    restore cleanly against the current schema
  inspect <name>                    Show per-table row counts + columns in a snapshot
  verify                            Post-restore smoke check (container, DB, owner,
                                    row counts, server /health)
  verify-postgres-databases [flags] M051: ensure logto_nautilo + logto role exist
                                    on the running cluster (upgrade-path counterpart
                                    to infra/postgres-init.sh)
                                    flags: --fix, --container <name>
  verify-config-env [flags]         M059: read-only validator — checks every
                                    LOGTO_* key in ~/.nautilo/instance.env.
                                    Exits 0 when valid.
                                    flags: --config-env <path>
  verify-pool-lifecycle [flags]     M210: read-only pool lifecycle QA —
                                    pg_stat before/after + 1,000 sequential
                                    and 50 parallel SELECT 1 via Neon proxy,
                                    split evenly across nautilo and
                                    nautilo_agent application pools.
                                    Requires --instance <non-default-name>.
                                    Remote --profile QA is manual SSH-host work.
  upgrade [flags]                   M059: auto-snapshot then run drizzle-kit
                                    migrate AND '@logto/cli db alteration deploy'
                                    in lock-step. The snapshot is the rollback
                                    path if either migrator fails.
                                    flags: --dry-run
  reset-logto-admin-password [flags] M059: rotate the Logto admin-console
                                    password to a freshly generated one and
                                    write ~/.nautilo/logto-admin.txt (chmod
                                    600). Recovery path for pre-M059 installs
                                    that never had the credential file.
                                    flags: --container <name>
  infra-start [flags]               M051: bring up legacy postgres +
                                    Logto compose stack + run bootstrap-logto.
                                    Idempotent. M071: optional --instance <id>
                                    (uses ~/.nautilo-<id>, auto-picked ports).
                                    --logto-already-provisioned is reserved for
                                    full instance clone orchestration.
  infra-stop [flags]                M051: tear down the stacks brought up by
                                    infra-start. Volumes preserved by default.
                                    flags: --with-volumes
  infra-status                      M051: report container + service-probe state
                                    of every infrastructure dependency.
  server-start [flags]              M100: start bin/nautilo-server --daemon for this
                                    instance (PID + logs under ~/.nautilo*; idempotent).
                                    If a foreign Nautilo server is already listening
                                    (no PID file, e.g. from 'bun run server'), claims
                                    it by writing the PID file.
                                    flags: --require-workbench-dist
  server-stop                       M100: stop the running server. Uses the PID file
                                    when present; falls back to a port-lookup +
                                    cmdline-match search for foreign servers.
  server-restart [flags]            M100: stop + start; resilient to foreign-launched
                                    servers via the same lookup as server-stop.
                                    flags: --require-workbench-dist
  server-status                     M100: PID (managed or foreign), /health,
                                    /api/setup/status, log path.
  clean [flags]                     Wipe to factory-fresh (DB empty, no instance.env)
                                    flags: --no-autosave
  migrate-to-logto [flags]          M053: link existing PIN-mode users to freshly
                                    created Logto accounts. Idempotent.
                                    flags: --dry-run, --output <path>,
                                           --config-env <path>
  migrate-from-logto [flags]        M053: roll back the link (clears users.external_id).
                                    flags: --dry-run, --delete-logto-users,
                                           --config-env <path>
  migrate-to-username-identity [flags] M107: flip Logto + local install to
                                    username-primary identifiers (dry-run
                                    default; --apply mutates; --rollback
                                    restores email-mode SIE only).
                                    flags: --apply, --rollback,
                                           --config-env <path>
  migrate-add-agent-role [flags]    D129 P3 (Stack 11.5): provision the
                                    'nautilo_agent' Postgres role + 'users_public'
                                    view + GRANT/REVOKE deltas against an existing
                                    populated DB whose volume already ran a
                                    pre-D129-P3 'postgres-init.sh'. Idempotent.
                                    Default mode is dry-run; pass --apply to mutate.
                                    flags: --apply, --container <name>
  migrate-artifacts [flags]         M088B: relocate legacy .artifacts rows + ingest
                                    flat ~/Documents/Nautilo files into the server
                                    artifact root. Idempotent. Pass A always runs;
                                    Pass B (flat-tree ingest) only runs when both
                                    --namespace-id and an agent id resolve.
                                    flags: --dry-run, --limit <N>, --config-env <path>,
                                           --agent-id <uuid>   (default: NAUTILO_DEFAULT_AGENT_ID),
                                           --namespace-id <uuid> (no default; required for Pass B)
  repair-logto-account-security [flags] D104: list users flagged for password change,
                                    or clear after operator confirmation.
                                    flags: --dry-run, --mark-complete <user-uuid>,
                                           --yes, --config-env <path>
  repair-orphan-default-agent [flags] D140: merge at most one orphan Agent and/or
                                    one orphan User per invocation into the active
                                    Agent + User. M128: auto-detect removed — pass
                                    --orphan-agent-id / --orphan-user-id explicitly.
                                    Refuses non-empty transcript footprint on the
                                    orphan unless --allow-active-orphan-merge.
                                    Default is dry-run; pass --apply to commit.
                                    flags: --apply, --keep-agent-id <uuid>,
                                           --keep-user-id <uuid>,
                                           --orphan-agent-id <uuid>,
                                           --orphan-user-id <uuid>,
                                           --allow-active-orphan-merge,
                                           --config-env <path>
  mark-all-messages-read [flags]    M158: one-time read baseline (D-2/MR5). Stamps
                                    every currently-unread, display-eligible (main
                                    user/assistant) message as read so the unread
                                    dot starts from "all caught up". Not a migration.
                                    Default is dry-run; pass --apply to commit.
                                    Guarded against the default instance; override
                                    with --i-know-what-i-am-doing.
                                    flags: --apply, --config-env <path>,
                                           --i-know-what-i-am-doing
  cleanup-test-cruft [flags]        Purge test-fixture users + their dependent
                                    agents/actors/rooms from a dev database
                                    while preserving designated real user(s).
                                    Read-only by default; surfaces every
                                    destructive action in a plan first.
                                    flags: --keep-user-handles <handle1,handle2>
                                           --keep-user-ids <uuid1,uuid2>
                                           --apply, --max-deletions <N>
                                           --allow-high-footprint
                                           --allow-fixture-user-ids <uuid,…>
                                           --plan-json
                                           --plan-out <path>   (with --plan-json;
                                                                atomically saves the
                                                                fingerprinted JSON
                                                                plan; refuses to
                                                                overwrite an existing
                                                                manifest)
                                           --fixture-plan <path>
                                           --approve-plan <sha256>
                                           --config-env <path>
                                    --allow-half-redeemed-fixtures is DEPRECATED
                                    (no-op, never authorizes deletion). On
                                    --apply, protected credentialless /
                                    half-redeemed candidates require the
                                    --fixture-plan + --approve-plan manifest
                                    gate; --allow-fixture-user-ids alone is
                                    for read-only / dry plan review only.
  reset-test-cruft --yes            Delete and recreate the named test-cruft
                                    instance using delete-instance + infra-start.
                                    Short-term recovery for contaminated
                                    integration-test scratch DBs.
  reset-logto-user-password [flags] D104: break-glass rotate a linked user's Logto
                                    password; write chmod-600 file under
                                    ~/.nautilo/password-resets/; flag operator_reset.
                                    Local shell only — not HTTP/MCP.
                                    flags: --email <addr> | --handle <h> | --user-id <uuid>
                                           (combinable if they resolve to one user),
                                           --dry-run | --yes, --print (with --yes only),
                                           --output-dir <path>, --config-env <path>
  verify-user-link --handle <name>  M053 / M107: report Nautilo↔Logto join
                                    state for a single user (--handle is M107
                                    primary; --email accepted as a deprecated
                                    one-release fallback). Exits 0 only when
                                    the user is cleanly linked.
  list | ls                         Show available snapshots
  list-instances [flags]            M071 + D153: list ~/.nautilo and ~/.nautilo-* (ports, compose project,
                                    /health, pid, cwd, age, STALE flag).
                                    flags: --json
  dev-stack [flags]                 D153 Phase 2: compose infra + workbench build + server + (optional)
                                    Electron in one Ctrl-C-aware orchestrator. Auto-derives instance from
                                    worktree. Port-collision detection vs other worktrees (no auto-kill).
                                    flags: --instance <name>, --electron, --no-build, --no-infra, --json
  qualify-owner-claim               D508: explicitly-authorized disposable real-Logto first-owner
                                    qualification. Generates and tears down one named local stack.
                                    Requires NAUTILO_D508_DISPOSABLE_QUALIFICATION=1.
  qualify-packaged-target           Test-only disposable packaged-target browser qualification.
                                    Requires --disposable --server <loopback-origin>
                                    --owner-config <absolute protected TOML>
                                    --target-instance <d508 + 12 lowercase hex>.
  cleanup-instances [flags]         Profile-aware, report-only local instance cleanup doctor.
                                    Always reports; never deletes. Shows server, Workbench, and Docker state.
                                    flags: --stale | --missing-instance-json | --name <pat>, --yes, --json
  nuke-client-cache [flags]         D156: atomic wipe of Electron renderer-side state for ONE
                                    (instance, profile) tuple. Dry-run by default; --yes executes.
                                    --instance is required. --instance default also requires
                                    --i-know-what-i-am-doing. Refuses running Electron.
                                    flags: --instance <name>, --profile <name>, --yes,
                                           --i-know-what-i-am-doing, --json
  setup-status [flags]              D112: GET /api/setup/status (human or JSON); exit 0 iff setupState=ready
                                    flags: --format json
  memory-promote [flags]            D324: list or promote archived memories (tier 2/3) back to tier 1.
                                    Dry-run by default; --apply writes. Direct DB update (local dev only).
                                    flags: --id <uuid>, --query <text>, --top <N>, --apply,
                                           --config-env <path>, --i-know-what-i-am-doing
  setup-instance [flags]          M100: consume ~/.config/nautilo/deploy.toml, claim if needed,
                                    write provider keys, reload-env (loopback), stamp deployConfigConsumedAt
                                    flags: --server <url>, --config <path>, --env-file <path>
                                    recovery-code safety: if claim succeeds but no session token is returned,
                                    dev:setup prints the one-time recovery codes before exiting non-zero
  gen-setup-template [flags]        D112 dev: emit SetupTemplateV1 TOML for smoke tests (not shipped in @nautilo/cli)
                                    flags: --instance <id> --out <path|-> [--randomize-genie] [--seed N]
                                           [--provider openai=env:OPENAI_API_KEY]...
                                           [--all-providers-from-secrets]
                                           [--password-env VAR] [--pin-env VAR] [--claim-code ... | --claim-env VAR]
                                           [--secrets-file <path>] [--no-secrets-file]
                                           [--handle ...] [--display-name ...]
  mcp <verb> [flags]                D384: inspect/configure MCP servers.
                                    verbs: list [--json] | test <name> | import <path> [--apply]
                                    test connects one server + lists its tools (no DB write);
                                    import parses a Claude-Desktop config (env NAMES only —
                                    secret values never stored), dry-run default, rows created disabled.
  delete-instance <id> --yes        M071: compose down -v + delete ~/.nautilo-<id> (named only)
  protect-instance <id>             Mark an existing named instance as durable and deletion-protected
  mint-user [flags] --yes           Stack 3 dev helper: provision a synthetic test user
                                    (Logto + nautilo users/actors + landing room) without
                                    going through the interactive invite ceremony. Writes
                                    credentials to ~/.nautilo/mint-user/*.txt (chmod 600).
                                    flags: --handle <h> --display-name <name> [required],
                                           --password <p> [random if omitted],
                                           --pin <6-8 digits> [random if omitted],
                                           --email <e> [defaults to <handle>@nautilo.local],
                                           --role <slug> [defaults to member],
                                           --output-dir <path>, --print (echo creds to stderr),
                                           --config-env <path>
  help                              Show this message

Global (all commands):
  --instance <id>                   M071: target ~/.nautilo-<id> (unset → ~/.nautilo).
                                    CLI wins over NAUTILO_INSTANCE_ID in the environment.
  --i-know-what-i-am-doing          D202: explicit opt-in to mutate the protected (default)
                                    instance (DB restore/upgrade/migrations/cleanup apply, etc.).
  (D112) Some Logto/DB commands     After loading instance.env, call GET /api/setup/status and
                                    refuse when setupState=fresh-unclaimed: migrate-to-logto,
                                    migrate-from-logto, migrate-to-username-identity, verify-user-link,
                                    repair-logto-account-security,
                                    reset-logto-user-password. Use \`bun run dev:setup-status\`.
                                    Infra, snapshots, verify (post-restore), and upgrade are not gated.

Examples:
  bun run dev:save my-working-setup
  bun run dev:preflight my-working-setup
  bun run dev:restore my-working-setup
  bun run dev:verify
  bun run dev:verify-postgres-databases
  bun run dev:verify-postgres-databases -- --fix
  bun run infra:start
  bun run infra:start -- --instance beta
  bun run infra:status
  bun run server:start
  bun run server:start -- --instance beta
  bun run server:status
  bun run server:stop
  bun run infra:stop
  bun run dev:restore my-working-setup --no-autosave
  bun run dev:clean
  bun run dev:reset-logto-user-password -- --email owner@example.com --dry-run
`.trim();

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx === args.length - 1) return undefined;
  return args[idx + 1];
}

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      // Skip the value of `--container <name>`-shape flags.
      if (VALUE_FLAGS.has(a) && i + 1 < args.length) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

async function main() {
  const rawArgv = process.argv.slice(2);
  const argv = stripInstancePairFromArgv(rawArgv);
  const [command, ...args] = argv.length ? argv : [];
  // Every command gets a side-effect-free help floor, including older
  // commands that do not yet own a command-specific HelpSpec. This check must
  // precede instance resolution because resolution and command dispatch may
  // touch operator state.
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE.trim());
    return;
  }
  try {
    // Pool verification and checkpoint inventory build their own isolated
    // target environments from the raw explicit selector. Validate against a
    // disposable object so `--instance` never changes this process's global
    // environment before either command applies its own fail-closed mapping.
    applyInstanceArgFromArgv(
      rawArgv,
      command === "verify-pool-lifecycle" || command === "compact-checkpoints" ? {} : process.env,
    );
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  const flags = {
    noAutosave: hasFlag(args, "--no-autosave"),
    fix: hasFlag(args, "--fix"),
    dryRun: hasFlag(args, "--dry-run"),
    deleteLogtoUsers: hasFlag(args, "--delete-logto-users"),
    yes: hasFlag(args, "--yes"),
    container: flagValue(args, "--container"),
    output: flagValue(args, "--output"),
    configEnv: flagValue(args, "--config-env"),
    email: flagValue(args, "--email"),
    handle: flagValue(args, "--handle"),
    userId: flagValue(args, "--user-id"),
    outputDir: flagValue(args, "--output-dir"),
    markComplete: flagValue(args, "--mark-complete"),
    print: hasFlag(args, "--print"),
    limit: flagValue(args, "--limit"),
    agentId: flagValue(args, "--agent-id"),
    namespaceId: flagValue(args, "--namespace-id"),
    displayName: flagValue(args, "--display-name"),
    password: flagValue(args, "--password"),
    pin: flagValue(args, "--pin"),
    role: flagValue(args, "--role"),
    keepAgentId: flagValue(args, "--keep-agent-id"),
    keepUserId: flagValue(args, "--keep-user-id"),
    orphanAgentId: flagValue(args, "--orphan-agent-id"),
    orphanUserId: flagValue(args, "--orphan-user-id"),
    allowActiveOrphanMerge: hasFlag(args, "--allow-active-orphan-merge"),
    keepUserHandles: flagValue(args, "--keep-user-handles"),
    keepUserIds: flagValue(args, "--keep-user-ids"),
    allowFixtureUserIds: flagValue(args, "--allow-fixture-user-ids"),
    fixturePlan: flagValue(args, "--fixture-plan"),
    approvePlan: flagValue(args, "--approve-plan"),
    maxDeletions: flagValue(args, "--max-deletions"),
    allowHighFootprint: hasFlag(args, "--allow-high-footprint"),
    allowHalfRedeemedFixtures: hasFlag(args, "--allow-half-redeemed-fixtures"),
    planJson: hasFlag(args, "--plan-json"),
    planOut: flagValue(args, "--plan-out"),
    apply: hasFlag(args, "--apply"),
    rollback: hasFlag(args, "--rollback"),
    requireWorkbenchDist: hasFlag(args, "--require-workbench-dist"),
    requireLogto: hasFlag(args, "--require-logto"),
    logtoAlreadyProvisioned: hasFlag(args, "--logto-already-provisioned"),
    office: hasFlag(args, "--office"),
    mode: flagValue(args, "--mode"),
    from: flagValue(args, "--from"),
    to: flagValue(args, "--to"),
    iKnowWhatIAmDoing: hasFlag(args, "--i-know-what-i-am-doing"),
  };
  const pos = positional(args);

  switch (command) {
    case "save":
      if (flags.mode !== undefined && flags.mode !== "dump" && flags.mode !== "basebackup") {
        console.error("save: --mode must be either 'dump' or 'basebackup'");
        process.exit(2);
      }
      await save(pos[0] ?? "", {
        ...(flags.mode === undefined ? {} : { mode: flags.mode as SaveBackupMode }),
        requireLogto: flags.requireLogto,
      });
      break;
    case "clone": {
      if (flags.from === undefined || flags.to === undefined) {
        console.error("clone: --from and --to are both required");
        process.exit(2);
      }
      const code = await cloneDevInstance({
        from: flags.from,
        to: flags.to,
      });
      process.exit(code);
      break;
    }
    case "compact-checkpoints": {
      // Pass raw argv: global instance normalization strips the pair from
      // `args`, but D489 requires proof that the operator explicitly chose it.
      const code = await compactCheckpointsCmd(rawArgv);
      process.exit(code);
      break;
    }
    case "restore":
      await restore(pos[0] ?? "", {
        noAutosave: flags.noAutosave,
        requireLogto: flags.requireLogto,
        iKnowWhatIAmDoing: flags.iKnowWhatIAmDoing,
      });
      break;
    case "preflight":
      await preflightCmd(pos[0] ?? "");
      break;
    case "inspect":
      await inspectCmd(pos[0] ?? "");
      break;
    case "verify":
      await verifyCmd();
      break;
    case "verify-postgres-databases": {
      const code = await verifyPostgresDatabases({
        fix: flags.fix,
        container: flags.container,
      });
      process.exit(code);
      break;
    }
    case "verify-config-env": {
      const code = verifyConfigEnv({ configEnvPath: flags.configEnv });
      process.exit(code);
      break;
    }
    case "verify-pool-lifecycle": {
      const explicitInstance = flagValue(rawArgv, "--instance");
      const code = await verifyPoolLifecycleCmd(args, { explicitInstance });
      process.exit(code);
      break;
    }
    case "upgrade": {
      const code = await upgrade({
        dryRun: flags.dryRun,
        iKnowWhatIAmDoing: flags.iKnowWhatIAmDoing,
      });
      process.exit(code);
      break;
    }
    case "reset-logto-admin-password": {
      const code = await resetLogtoAdminPassword({
        container: flags.container,
      });
      process.exit(code);
      break;
    }
    case "infra-start": {
      const code = await infraStart({
        iKnowWhatIAmDoing: flags.iKnowWhatIAmDoing,
        logtoAlreadyProvisioned: flags.logtoAlreadyProvisioned,
        office: flags.office,
      });
      process.exit(code);
      break;
    }
    case "infra-stop": {
      const code = await infraStop({ withVolumes: hasFlag(args, "--with-volumes") });
      process.exit(code);
      break;
    }
    case "infra-status": {
      const code = await infraStatus();
      process.exit(code);
      break;
    }
    case "server-start": {
      const code = await serverStart({ requireWorkbenchDist: flags.requireWorkbenchDist });
      process.exit(code);
      break;
    }
    case "server-stop": {
      const code = await serverStop();
      process.exit(code);
      break;
    }
    case "server-status": {
      const code = await serverStatus();
      process.exit(code);
      break;
    }
    case "server-restart": {
      const code = await serverRestart({ requireWorkbenchDist: flags.requireWorkbenchDist });
      process.exit(code);
      break;
    }
    case "clean":
      await clean({ noAutosave: flags.noAutosave });
      break;
    case "migrate-to-logto": {
      const code = await migrateToLogto({
        dryRun: flags.dryRun,
        outputPath: flags.output,
        configEnvPath: flags.configEnv,
        iKnowWhatIAmDoing: flags.iKnowWhatIAmDoing,
      });
      process.exit(code);
      break;
    }
    case "migrate-from-logto": {
      const code = await migrateFromLogto({
        dryRun: flags.dryRun,
        deleteLogtoUsers: flags.deleteLogtoUsers,
        configEnvPath: flags.configEnv,
        iKnowWhatIAmDoing: flags.iKnowWhatIAmDoing,
      });
      process.exit(code);
      break;
    }
    case "migrate-to-username-identity": {
      const code = await migrateToUsernameIdentity({
        apply: flags.apply,
        rollback: flags.rollback,
        configEnvPath: flags.configEnv,
        iKnowWhatIAmDoing: flags.iKnowWhatIAmDoing,
      });
      process.exit(code);
      break;
    }
    case "migrate-add-agent-role": {
      const code = await migrateAddAgentRole({
        apply: flags.apply,
        iKnowWhatIAmDoing: flags.iKnowWhatIAmDoing,
        ...(flags.container ? { container: flags.container } : {}),
      });
      process.exit(code);
      break;
    }
    case "migrate-artifacts": {
      let limit: number | undefined;
      if (flags.limit !== undefined) {
        const n = Number(flags.limit);
        if (!Number.isInteger(n) || n <= 0) {
          console.error(
            "migrate-artifacts: --limit must be a positive integer",
          );
          process.exit(2);
        }
        limit = n;
      }
      const code = await migrateArtifacts({
        dryRun: flags.dryRun,
        limit,
        configEnvPath: flags.configEnv,
        iKnowWhatIAmDoing: flags.iKnowWhatIAmDoing,
        ...(flags.agentId ? { agentId: flags.agentId } : {}),
        ...(flags.namespaceId ? { namespaceId: flags.namespaceId } : {}),
      });
      process.exit(code);
      break;
    }
    case "repair-logto-account-security": {
      const code = await repairLogtoAccountSecurity({
        dryRun: flags.dryRun,
        markCompleteUserId: flags.markComplete,
        yes: flags.yes,
        configEnvPath: flags.configEnv,
      });
      process.exit(code);
      break;
    }
    case "repair-orphan-default-agent": {
      // M128: auto-detect removed — per-Agent ownership groups retired.
      // Operators must pass --orphan-agent-id / --orphan-user-id explicitly.
      const code = await repairOrphanDefaultAgent({
        apply: flags.apply,
        keepAgentId: flags.keepAgentId,
        keepUserId: flags.keepUserId,
        orphanAgentId: flags.orphanAgentId,
        orphanUserId: flags.orphanUserId,
        allowActiveOrphanMerge: flags.allowActiveOrphanMerge,
        configEnvPath: flags.configEnv,
        iKnowWhatIAmDoing: flags.iKnowWhatIAmDoing,
      });
      process.exit(code);
      break;
    }
    case "mark-all-messages-read": {
      const code = await markAllMessagesRead({
        apply: flags.apply,
        configEnvPath: flags.configEnv,
        iKnowWhatIAmDoing: flags.iKnowWhatIAmDoing,
      });
      process.exit(code);
      break;
    }
    case "cleanup-test-cruft": {
      const code = await cleanupTestCruft({
        keepUserHandles: flags.keepUserHandles,
        keepUserIds: flags.keepUserIds,
        apply: flags.apply,
        maxDeletions: flags.maxDeletions,
        allowHighFootprint: flags.allowHighFootprint,
        allowHalfRedeemedFixtures: flags.allowHalfRedeemedFixtures,
        allowFixtureUserIds: flags.allowFixtureUserIds,
        fixturePlan: flags.fixturePlan,
        approvePlan: flags.approvePlan,
        planJson: flags.planJson,
        planOut: flags.planOut,
        configEnvPath: flags.configEnv,
        iKnowWhatIAmDoing: flags.iKnowWhatIAmDoing,
      });
      process.exit(code);
      break;
    }
    case "reset-test-cruft": {
      const code = await resetTestCruft({ yes: flags.yes });
      process.exit(code);
      break;
    }
    case "reset-logto-user-password": {
      const code = await resetLogtoUserPassword({
        email: flags.email,
        handle: flags.handle,
        userId: flags.userId,
        dryRun: flags.dryRun,
        yes: flags.yes,
        print: flags.print,
        outputDir: flags.outputDir,
        configEnvPath: flags.configEnv,
      });
      process.exit(code);
      break;
    }
    case "mint-user": {
      const code = await mintUser({
        handle: flags.handle,
        displayName: flags.displayName,
        password: flags.password,
        pin: flags.pin,
        email: flags.email,
        role: flags.role,
        yes: flags.yes,
        print: flags.print,
        outputDir: flags.outputDir,
        configEnvPath: flags.configEnv,
      });
      process.exit(code);
      break;
    }
    case "verify-user-link": {
      const code = await verifyUserLink({
        handle: flags.handle,
        email: flags.email,
        configEnvPath: flags.configEnv,
      });
      process.exit(code);
      break;
    }
    case "cleanup-instances": {
      await cleanupInstancesCmd(args);
      break;
    }
    case "nuke-client-cache": {
      // This command owns an explicit required `--instance` argument so it can
      // distinguish a deliberate default-cache wipe from an inherited target.
      // The global instance bootstrap strips that pair from `args`; pass the
      // original command tail so the command can enforce its own guard and the
      // documented `bun run dev:nuke-client-cache --instance ...` form works.
      const code = await nukeClientCacheCmd(rawArgv.slice(1));
      process.exit(code);
      break;
    }
    case "list-instances": {
      await listInstancesCmd();
      break;
    }
    case "setup-status": {
      const code = await setupStatusCmd(args);
      process.exit(code);
      break;
    }
    case "memory-promote":
    case "memory:promote": {
      const code = await memoryPromoteCmd(args);
      process.exit(code);
      break;
    }
    case "setup-instance": {
      const code = await setupInstanceCmd(args);
      process.exit(code);
      break;
    }
    case "gen-setup-template": {
      try {
        if (args.some((arg) => arg === "--force-password-change" || arg.startsWith("--force-password-change="))) {
          throw new Error("unknown option: --force-password-change");
        }
        const instance =
          process.env["NAUTILO_INSTANCE_ID"]?.trim() ||
          flagValue(args, "--instance")?.trim() ||
          "";
        if (!instance) {
          console.error("missing --instance <id> (or NAUTILO_INSTANCE_ID)");
          process.exit(2);
          break;
        }
        const providers: string[] = [];
        for (let i = 0; i < args.length; i++) {
          if (args[i] === "--provider" && i + 1 < args.length) {
            providers.push(args[++i]!);
          }
        }
        const code = await genSetupTemplateCmd({
          instance,
          randomizeGenie: hasFlag(args, "--randomize-genie"),
          seed: flagValue(args, "--seed")
            ? Number(flagValue(args, "--seed"))
            : undefined,
          providers,
          out: flagValue(args, "--out") ?? "-",
          passwordEnv: flagValue(args, "--password-env"),
          pinEnv: flagValue(args, "--pin-env"),
          claimCode: flagValue(args, "--claim-code"),
          claimEnv: flagValue(args, "--claim-env"),
          handle: flagValue(args, "--handle"),
          displayName: flagValue(args, "--display-name"),
          secretsFile: flagValue(args, "--secrets-file"),
          noSecretsFile: hasFlag(args, "--no-secrets-file"),
          allProvidersFromSecrets: hasFlag(args, "--all-providers-from-secrets"),
        });
        process.exit(code);
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(2);
      }
      break;
    }
    case "delete-instance": {
      const code = await deleteInstance({
        id: pos[0] ?? "",
        yes: flags.yes,
      });
      process.exit(code);
      break;
    }
    case "protect-instance": {
      process.exit(protectInstance({ id: pos[0] ?? "" }));
      break;
    }
    case "dev-stack": {
      const code = await devStackCmd(args);
      process.exit(code);
      break;
    }
    case "qualify-owner-claim": {
      const code = await qualifyOwnerClaimCmd(args);
      process.exit(code);
      break;
    }
    case "qualify-packaged-target": {
      const code = await qualifyPackagedTargetCmd(args);
      process.exit(code);
      break;
    }
    case "office": {
      const code = await officeCmd(args);
      process.exit(code);
      break;
    }
    case "mcp": {
      const code = await mcpCmd(args);
      process.exit(code);
      break;
    }
    case "list":
    case "ls":
      await list();
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(USAGE);
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
