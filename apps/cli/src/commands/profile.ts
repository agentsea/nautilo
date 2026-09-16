import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { CommandModule } from "yargs";
import { stringify } from "smol-toml";
import { profilesRootDir, resolveTransportEndpoint } from "../lib/api-client.ts";
import {
  INSTANCE_ID_RE,
  LOCAL_COMPOSE_ENDPOINT_AUTHORITY_ERROR,
  loadProfile,
  loadProfileFromObject,
  type Profile,
} from "../lib/profile-schema.ts";
import { bootstrapTokenPath, deleteBootstrapToken } from "../lib/bootstrap-tokens.ts";
import { readLine } from "../lib/prompts.ts";

async function promptOrUse<T>(
  flagValue: T | undefined,
  promptText: string,
  parser: (s: string) => T | null,
): Promise<T> {
  if (flagValue !== undefined) return flagValue;
  for (;;) {
    const raw = await readLine(promptText);
    const parsed = parser(raw);
    if (parsed !== null) return parsed;
    process.stderr.write("Invalid input, try again.\n");
  }
}

function optionalFlagString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

function hasRemoteOnlyFlags(argv: Record<string, unknown>): boolean {
  return (
    optionalFlagString(argv["ssh-host"]) !== undefined ||
    optionalFlagString(argv["ssh-user"]) !== undefined ||
    optionalFlagString(argv["ssh-identity-file"]) !== undefined ||
    optionalFlagString(argv["ssh-known-hosts-file"]) !== undefined ||
    (typeof argv["ssh-port"] === "number" && Number.isFinite(argv["ssh-port"])) ||
    optionalFlagString(argv["remote-path"]) !== undefined ||
    optionalFlagString(argv["base-url"]) !== undefined
  );
}

export const LOCAL_COMPOSE_ENDPOINT_FLAGS_ERROR = `${LOCAL_COMPOSE_ENDPOINT_AUTHORITY_ERROR}\n`;

function formatInvalidProfileError(name: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const prefix = `Invalid profile '${name}': `;
  const detail = msg.startsWith(prefix) ? msg.slice(prefix.length) : msg;
  return `Invalid profile: ${detail}\n`;
}

function activeFile(home: string): string {
  return join(profilesRootDir(home), ".active");
}

function profileToml(home: string, name: string): string {
  return join(profilesRootDir(home), `${name}.toml`);
}

function legacyProfileEnv(home: string, name: string): string {
  return join(profilesRootDir(home), `${name}.env`);
}

function ensureProfilesDir(home: string): void {
  mkdirSync(profilesRootDir(home), { recursive: true, mode: 0o700 });
}

function readHome(argv: Record<string, unknown>): string {
  const fromArgv = argv["home"];
  if (typeof fromArgv === "string" && fromArgv.trim() !== "") {
    return fromArgv.trim();
  }
  const h = process.env["HOME"];
  if (!h || h.trim() === "") {
    throw new Error("HOME is not set");
  }
  return h;
}

const listCmd: CommandModule = {
  command: "list",
  describe: "profile list — print profile names",
  builder: (y) =>
    y.option("home", {
      type: "string",
      hidden: true,
      describe: "Override HOME (tests)",
    }),
  handler: (argv) => {
    const home = readHome(argv as Record<string, unknown>);
    ensureProfilesDir(home);
    const names = readdirSync(profilesRootDir(home))
      .filter((f) => f.endsWith(".toml"))
      .map((f) => f.replace(/\.toml$/, ""))
      .sort();
    if (names.length === 0) {
      process.stdout.write("profile list: (none)\n");
    } else {
      for (const n of names) {
        process.stdout.write(`${n}\n`);
      }
    }
    process.exitCode = 0;
  },
};

const addCmd: CommandModule = {
  command: "add <name>",
  describe: "profile add — create ~/.nautilo/profiles/<name>.toml",
  builder: (y) =>
    y
      .positional("name", { type: "string", demandOption: true })
      .option("transport", {
        type: "string",
        choices: ["local", "remote"] as const,
        describe: "Profile transport",
      })
      .option("lifecycle", {
        type: "string",
        choices: ["compose", "external"] as const,
        describe: "Profile lifecycle",
      })
      .option("instance-id", { type: "string", describe: "Instance id (compose lifecycle)" })
      .option("retention", { type: "string", choices: ["durable", "disposable"] as const, describe: "Local Compose instance retention (default: durable)" })
      .option("office", { type: "boolean", describe: "Enable the office/Collabora feature for this profile (compose lifecycle)" })
      .option("host", { type: "string", describe: "Server host (local transport)" })
      .option("port", { type: "number", describe: "Server port (local transport)" })
      .option("domain", { type: "string", describe: "Server domain (remote transport)" })
      .option("ssh-host", { type: "string", describe: "SSH host (remote compose)" })
      .option("ssh-user", { type: "string", describe: "SSH user (remote compose)" })
      .option("ssh-identity-file", { type: "string", describe: "SSH identity file (remote compose)" })
      .option("ssh-known-hosts-file", { type: "string", describe: "Dedicated SSH known_hosts path (remote compose)" })
      .option("ssh-port", { type: "number", describe: "SSH port (remote compose)" })
      .option("remote-path", { type: "string", describe: "Remote instance path (remote compose)" })
      .option("base-url", { type: "string", describe: "API base URL (remote compose)" })
      .option("https", { type: "string", choices: ["off", "letsencrypt"] as const, describe: "HTTPS mode for a remote profile" })
      .option("acme-email", { type: "string", describe: "ACME registration email (https=letsencrypt)" })
      .option("acme-staging", { type: "boolean", describe: "Use LE staging endpoint (https=letsencrypt)" })
      .option("yes", { type: "boolean", default: false, describe: "Skip interactive wizard" })
      .option("use", {
        type: "boolean",
        default: true,
        describe: "Set as active profile after create",
      })
      .option("home", { type: "string", hidden: true })
      .example("$0 profile add production", "Create and activate a local Docker Compose profile interactively."),
  handler: async (argv) => {
    const home = readHome(argv as Record<string, unknown>);
    const rawName = argv["name"];
    const name = (typeof rawName === "string" ? rawName : "").trim();
    if (!name || name.includes("/") || name.includes("\\") || name === ".active") {
      process.stderr.write("Invalid profile name.\n");
      process.exitCode = 2;
      return;
    }
    if (argv["image"] !== undefined) {
      process.stderr.write(
        "profile add: --image is no longer supported; use deploy --image <digest> or upgrade --image <digest>.\n",
      );
      process.exitCode = 2;
      return;
    }

    const interactive = process.stdin.isTTY === true && argv["yes"] !== true;
    const transportFlag = optionalFlagString(argv["transport"]);

    if (!interactive && transportFlag === undefined) {
      process.stderr.write(
        "Refusing to run interactive wizard on non-TTY stdin. Pass --yes plus all required flags.\n",
      );
      process.exitCode = 2;
      return;
    }

    ensureProfilesDir(home);
    const tPath = profileToml(home, name);
    if (existsSync(tPath)) {
      process.stderr.write(`Profile '${name}' already exists.\n`);
      process.exitCode = 2;
      return;
    }

    const lifecycleFlag = optionalFlagString(argv["lifecycle"]);
    const domainFlag = optionalFlagString(argv["domain"]);
    const instanceIdFlag = optionalFlagString(argv["instance-id"]);
    const retentionFlag = optionalFlagString(argv["retention"]);
    const hostFlag = optionalFlagString(argv["host"]);
    const portFlag = typeof argv["port"] === "number" && Number.isFinite(argv["port"])
      ? argv["port"]
      : undefined;
    const officeFlag =
      typeof argv["office"] === "boolean" ? argv["office"] : undefined;
    const sshHostFlag = optionalFlagString(argv["ssh-host"]);
    const sshUserFlag = optionalFlagString(argv["ssh-user"]);
    const sshIdentityFlag = optionalFlagString(argv["ssh-identity-file"]);
    const sshKnownHostsFlag = optionalFlagString(argv["ssh-known-hosts-file"]);
    const sshPortFlag =
      typeof argv["ssh-port"] === "number" && Number.isFinite(argv["ssh-port"])
        ? argv["ssh-port"]
        : undefined;
    const remotePathFlag = optionalFlagString(argv["remote-path"]);
    const baseUrlFlag = optionalFlagString(argv["base-url"]);
    const httpsFlag = optionalFlagString(argv["https"]);
    const acmeEmailFlag = optionalFlagString(argv["acme-email"]);
    const acmeStagingFlag = typeof argv["acme-staging"] === "boolean" ? argv["acme-staging"] : undefined;
    const argvRecord = argv as Record<string, unknown>;

    let transport: "local" | "remote";
    if (transportFlag !== undefined) {
      if (transportFlag !== "local" && transportFlag !== "remote") {
        process.stderr.write("Invalid transport; use local or remote.\n");
        process.exitCode = 2;
        return;
      }
      transport = transportFlag;
    } else {
      transport = await promptOrUse(
        undefined,
        "Transport [local / remote] (local): ",
        (s) => {
          const t = s.trim();
          if (t === "") return "local";
          if (t === "local" || t === "remote") return t;
          return null;
        },
      );
    }

    const rawObj: Record<string, unknown> = { name, transport };

    if (transport === "remote") {
      if (retentionFlag !== undefined) {
        process.stderr.write("--retention is only supported for local Compose profiles.\n");
        process.exitCode = 2;
        return;
      }
      if (hostFlag !== undefined || portFlag !== undefined) {
        process.stderr.write(
          "--host / --port are local-transport flags; use --ssh-host / --ssh-port for remote.\n",
        );
        process.exitCode = 2;
        return;
      }

      let lifecycle: "compose" | "external";
      if (lifecycleFlag !== undefined) {
        if (lifecycleFlag !== "compose" && lifecycleFlag !== "external") {
          process.stderr.write("Invalid lifecycle; use compose or external.\n");
          process.exitCode = 2;
          return;
        }
        lifecycle = lifecycleFlag;
      } else if (interactive) {
        lifecycle = await promptOrUse(
          undefined,
          "Lifecycle [compose / external] (external): ",
          (s) => {
            const t = s.trim();
            if (t === "") return "external";
            if (t === "compose" || t === "external") return t;
            return null;
          },
        );
      } else {
        lifecycle = "external";
      }
      rawObj["lifecycle"] = lifecycle;

      if (lifecycle === "external") {
        if (hasRemoteOnlyFlags(argvRecord)) {
          process.stderr.write(
            "--ssh-* / --remote-path / --base-url are only meaningful when lifecycle=compose.\n",
          );
          process.exitCode = 2;
          return;
        }

        let domain = domainFlag;
        if (domain === undefined && interactive) {
          domain = await promptOrUse(undefined, "Server domain (e.g. nautilo.alice.example): ", (s) => {
            const t = s.trim();
            return t === "" ? null : t;
          });
        }
        if (!interactive && argv["yes"] === true && (domain === undefined || domain.trim() === "")) {
          process.stderr.write("Invalid profile: domain: domain is required for remote transport\n");
          process.exitCode = 2;
          return;
        }
        if (domain !== undefined) rawObj["domain"] = domain;
      } else {
        let sshHost = sshHostFlag;
        if (sshHost === undefined && interactive) {
          sshHost = await promptOrUse(undefined, "SSH host: ", (s) => {
            const t = s.trim();
            return t === "" ? null : t;
          });
        }
        let sshUser = sshUserFlag;
        if (sshUser === undefined && interactive) {
          sshUser = await promptOrUse(undefined, "SSH user: ", (s) => {
            const t = s.trim();
            return t === "" ? null : t;
          });
        }
        if (!interactive && argv["yes"] === true && (sshHost === undefined || sshUser === undefined)) {
          process.stderr.write("Invalid profile: ssh: ssh block is required when lifecycle=compose\n");
          process.exitCode = 2;
          return;
        }

        if (sshHost !== undefined && sshUser !== undefined) {
          const ssh: Record<string, unknown> = { host: sshHost, user: sshUser };
          if (sshIdentityFlag !== undefined) ssh["identity_file"] = sshIdentityFlag;
          if (sshKnownHostsFlag !== undefined) ssh["known_hosts_file"] = sshKnownHostsFlag;
          if (sshPortFlag !== undefined) ssh["port"] = sshPortFlag;
          rawObj["ssh"] = ssh;
        }

        if (remotePathFlag !== undefined) rawObj["remote_path"] = remotePathFlag;
        if (baseUrlFlag !== undefined) rawObj["base_url"] = baseUrlFlag;

        let instanceId = instanceIdFlag;
        if (instanceId === undefined && interactive) {
          instanceId = await promptOrUse(
            undefined,
            "Instance id (blank = shared default): ",
            (s) => {
              const t = s.trim();
              if (t === "") return "";
              return INSTANCE_ID_RE.test(t) ? t : null;
            },
          );
        }
        if (instanceId !== undefined && instanceId !== "") {
          if (!INSTANCE_ID_RE.test(instanceId)) {
            process.stderr.write(formatInvalidProfileError(name, new Error(`Invalid profile '${name}': instance_id: Invalid`)));
            process.exitCode = 2;
            return;
          }
          rawObj["instance_id"] = instanceId;
        }

        if (officeFlag !== undefined) rawObj["office"] = officeFlag;

        if (httpsFlag !== undefined && httpsFlag !== "letsencrypt" && httpsFlag !== "off") {
          process.stderr.write("Invalid --https value. Use off or letsencrypt.\n");
          process.exitCode = 2;
          return;
        }
        if (httpsFlag !== undefined) rawObj["https"] = httpsFlag;
        if (acmeEmailFlag !== undefined) rawObj["acme_email"] = acmeEmailFlag;
        if (acmeStagingFlag !== undefined) rawObj["acme_staging"] = acmeStagingFlag;
        if (domainFlag !== undefined) rawObj["domain"] = domainFlag;

        if (
          domainFlag !== undefined &&
          (httpsFlag === undefined || httpsFlag === "off")
        ) {
          process.stderr.write(
            "[profile add] warning: --domain set but --https=off; the domain will not be served encrypted.\n",
          );
        }
      }
    } else {
      if (httpsFlag !== undefined && httpsFlag !== "off") {
        process.stderr.write("--https=letsencrypt requires --transport=remote.\n");
        process.exitCode = 2;
        return;
      }
      if (acmeEmailFlag !== undefined) {
        process.stderr.write("--acme-email requires --transport=remote.\n");
        process.exitCode = 2;
        return;
      }
      if (acmeStagingFlag !== undefined) {
        process.stderr.write("--acme-staging requires --transport=remote.\n");
        process.exitCode = 2;
        return;
      }

      if (hasRemoteOnlyFlags(argvRecord)) {
        process.stderr.write(
          "--ssh-host / --ssh-user / --ssh-identity-file / --ssh-known-hosts-file / --ssh-port / --remote-path / --base-url require --transport=remote.\n",
        );
        process.exitCode = 2;
        return;
      }

      let lifecycle: "compose" | "external";
      if (lifecycleFlag !== undefined) {
        if (lifecycleFlag !== "compose" && lifecycleFlag !== "external") {
          process.stderr.write("Invalid lifecycle; use compose or external.\n");
          process.exitCode = 2;
          return;
        }
        lifecycle = lifecycleFlag;
      } else if (interactive) {
        lifecycle = await promptOrUse(
          undefined,
          "Lifecycle [compose / external] (compose): ",
          (s) => {
            const t = s.trim();
            if (t === "") return "compose";
            if (t === "compose" || t === "external") return t;
            return null;
          },
        );
      } else {
        lifecycle = "compose";
      }
      rawObj["lifecycle"] = lifecycle;

      if (lifecycle === "compose") {
        // Compose instance identity owns its listener bundle. Accepting these
        // flags here used to persist an ignored endpoint override before any
        // instance existed, making collision-safe allocation ambiguous.
        if (hostFlag !== undefined || portFlag !== undefined) {
          process.stderr.write(LOCAL_COMPOSE_ENDPOINT_FLAGS_ERROR);
          process.exitCode = 2;
          return;
        }

        let instanceId = instanceIdFlag;
        if (instanceId === undefined && interactive) {
          instanceId = await promptOrUse(
            undefined,
            "Instance id (blank = shared default): ",
            (s) => {
              const t = s.trim();
              if (t === "") return "";
              return INSTANCE_ID_RE.test(t) ? t : null;
            },
          );
        }
        if (instanceId !== undefined && instanceId !== "") {
          if (!INSTANCE_ID_RE.test(instanceId)) {
            process.stderr.write(formatInvalidProfileError(name, new Error(`Invalid profile '${name}': instance_id: Invalid`)));
            process.exitCode = 2;
            return;
          }
          rawObj["instance_id"] = instanceId;
        }

        if (officeFlag !== undefined) rawObj["office"] = officeFlag;
        rawObj["retention"] = retentionFlag ?? "durable";

      } else {
        if (retentionFlag !== undefined) {
          process.stderr.write("--retention is only supported for local Compose profiles.\n");
          process.exitCode = 2;
          return;
        }
        if (
          instanceIdFlag !== undefined
        ) {
          process.stderr.write(
            "--instance-id is only meaningful when lifecycle=compose.\n",
          );
          process.exitCode = 2;
          return;
        }

        let host = hostFlag;
        if (host === undefined && interactive) {
          host = await promptOrUse(undefined, "Server host (127.0.0.1): ", (s) => {
            const t = s.trim();
            return t === "" ? "" : t;
          });
        }
        if (host !== undefined && host !== "") rawObj["host"] = host;

        type PortPrompt = number | "omit";
        let port: number | undefined = portFlag;
        if (port === undefined && interactive) {
          const answered = await promptOrUse<PortPrompt>(undefined, "Server port (3001): ", (s) => {
            const t = s.trim();
            if (t === "") return "omit";
            const n = Number.parseInt(t, 10);
            if (!Number.isInteger(n) || n <= 0) return null;
            return n;
          });
          if (answered !== "omit") port = answered;
        }
        if (port !== undefined) rawObj["port"] = port;
      }
    }

    let validated: Profile;
    try {
      validated = loadProfileFromObject(rawObj, name);
    } catch (e) {
      process.stderr.write(formatInvalidProfileError(name, e));
      process.exitCode = 2;
      return;
    }

    if (interactive) {
      process.stdout.write(stringify(validated));
      const confirm = await readLine("Write this profile? [Y/n]: ");
      const c = confirm.trim().toLowerCase();
      if (c === "n" || c === "no") {
        process.stderr.write("Aborted.\n");
        process.exitCode = 2;
        return;
      }
    }

    writeFileSync(tPath, stringify(validated), { mode: 0o644 });
    chmodSync(tPath, 0o644);

    const setActive = argv["use"] !== false;
    if (setActive) {
      writeFileSync(activeFile(home), `${name}\n`, { mode: 0o600 });
      chmodSync(activeFile(home), 0o600);
    }

    if (transport === "remote") {
      if (validated.lifecycle === "compose") {
        process.stderr.write(
          "[profile add] Remote Compose day-two commands use SSH; no local bootstrap token is required.\n",
        );
        process.stderr.write(
          "[profile add] Remote compose setup: see playbook/operator/remote-droplet-setup.md\n",
        );
      } else {
        process.stderr.write(
          `[profile add] Remote external setup API commands require the first-install credential at ~/.nautilo/bootstrap-tokens/${name} (mode 0600).\n`,
        );
      }
    }

    if (setActive) {
      process.stdout.write(
        `profile add: created '${name}' and set as active.\n`,
      );
    } else {
      process.stdout.write(
        `profile add: created '${name}' (transport=${validated.transport}, lifecycle=${validated.lifecycle}).\n`,
      );
    }
    process.exitCode = 0;
  },
};

const setCmd: CommandModule = {
  command: "set <field> <value>",
  describe: "profile set — set a profile field (currently: office). Requires a redeploy to take effect.",
  builder: (y) =>
    y
      .positional("field", { type: "string", demandOption: true })
      .positional("value", { type: "string", demandOption: true })
      .option("home", { type: "string", hidden: true }),
  handler: (argv) => {
    const home = readHome(argv as Record<string, unknown>);
    const field = (typeof argv["field"] === "string" ? argv["field"] : "").trim();
    if (field !== "office") {
      process.stderr.write(`profile set: unsupported field '${field}'. Supported: office.\n`);
      process.exitCode = 2;
      return;
    }
    const rawValue = (typeof argv["value"] === "string" ? argv["value"] : "").trim().toLowerCase();
    let office: boolean;
    if (rawValue === "true" || rawValue === "on" || rawValue === "yes") office = true;
    else if (rawValue === "false" || rawValue === "off" || rawValue === "no") office = false;
    else {
      process.stderr.write(`profile set office: value must be true/false (got '${rawValue}').\n`);
      process.exitCode = 2;
      return;
    }

    // Resolve target profile: global --profile flag, else the active profile.
    const profileFlag = optionalFlagString(argv["profile"]);
    let name = profileFlag;
    if (name === undefined) {
      const af = activeFile(home);
      if (!existsSync(af)) {
        process.stderr.write("No active profile. Run: nautilo profile use <name> (or pass --profile <name>).\n");
        process.exitCode = 2;
        return;
      }
      name = readFileSync(af, "utf8").trim();
    }
    if (!name) {
      process.stderr.write("Could not resolve a profile name.\n");
      process.exitCode = 2;
      return;
    }

    let profile: Profile;
    try {
      profile = loadProfile(name, home);
    } catch (e) {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 2;
      return;
    }
    if (profile.lifecycle !== "compose") {
      process.stderr.write(
        `profile set office: '${name}' is lifecycle=${profile.lifecycle}; office only applies to compose-lifecycle profiles.\n`,
      );
      process.exitCode = 2;
      return;
    }

    let validated: Profile;
    try {
      validated = loadProfileFromObject({ ...profile, office }, name);
    } catch (e) {
      process.stderr.write(formatInvalidProfileError(name, e));
      process.exitCode = 2;
      return;
    }

    const tPath = profileToml(home, name);
    writeFileSync(tPath, stringify(validated), { mode: 0o644 });
    chmodSync(tPath, 0o644);

    process.stdout.write(`profile set: office=${office} for profile '${name}'.\n`);
    process.stderr.write(
      `[profile set] A redeploy is required for this to take effect. Run: nautilo upgrade --profile ${name} (or nautilo deploy --profile ${name}).\n`,
    );
    process.exitCode = 0;
  },
};

const useCmd: CommandModule = {
  command: "use <name>",
  describe: "profile use — set active profile",
  builder: (y) =>
    y
      .positional("name", { type: "string", demandOption: true })
      .option("home", { type: "string", hidden: true }),
  handler: (argv) => {
    const home = readHome(argv as Record<string, unknown>);
    const rawName = argv["name"];
    const name = (typeof rawName === "string" ? rawName : "").trim();
    try {
      loadProfile(name, home);
    } catch (e) {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 2;
      return;
    }
    ensureProfilesDir(home);
    writeFileSync(activeFile(home), `${name}\n`, { mode: 0o600 });
    chmodSync(activeFile(home), 0o600);
    process.stdout.write(`profile use: active profile is '${name}'.\n`);
    process.exitCode = 0;
  },
};

const removeCmd: CommandModule = {
  command: "remove <name>",
  describe: "profile remove — delete a profile",
  builder: (y) =>
    y
      .positional("name", { type: "string", demandOption: true })
      .option("yes", { type: "boolean", default: false, describe: "Confirm removal of durable local instance authority" })
      .option("home", { type: "string", hidden: true }),
  handler: (argv) => {
    const home = readHome(argv as Record<string, unknown>);
    const rawName = argv["name"];
    const name = (typeof rawName === "string" ? rawName : "").trim();
    const tPath = profileToml(home, name);
    const legacyEnv = legacyProfileEnv(home, name);
    if (!existsSync(tPath)) {
      process.stderr.write(`Unknown profile '${name}'.\n`);
      process.exitCode = 2;
      return;
    }
    let profile: Profile;
    try {
      profile = loadProfile(name, home);
    } catch (e) {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 2;
      return;
    }
    if (profile.transport === "local" && profile.lifecycle === "compose" && profile.retention === "durable") {
      if (argv["yes"] !== true) {
        process.stderr.write(`Profile '${name}' is durable deletion authority. Re-run with --yes only when retiring that protection.\n`);
        process.exitCode = 2;
        return;
      }
      process.stderr.write(`Warning: removing durable profile '${name}' retires its external deletion protection; an instance-local marker may still protect the current root.\n`);
    }
    try {
      unlinkSync(tPath);
    } catch (e) {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 2;
      return;
    }
    try {
      if (existsSync(legacyEnv)) unlinkSync(legacyEnv);
    } catch {
      /* best effort */
    }
    try {
      deleteBootstrapToken(name, { home });
    } catch {
      /* best effort */
    }
    const af = activeFile(home);
    if (existsSync(af) && readFileSync(af, "utf8").trim() === name) {
      try {
        unlinkSync(af);
      } catch {
        /* noop */
      }
    }
    process.stdout.write(`profile remove: removed '${name}'.\n`);
    process.exitCode = 0;
  },
};

const currentCmd: CommandModule = {
  command: "current",
  describe: "profile current — show active profile and configured endpoint",
  builder: (y) => y.option("home", { type: "string", hidden: true }),
  handler: async (argv) => {
    const home = readHome(argv as Record<string, unknown>);
    const af = activeFile(home);
    if (!existsSync(af)) {
      process.stderr.write("No active profile. Run: nautilo profile use <name>\n");
      process.exitCode = 2;
      return;
    }
    const name = readFileSync(af, "utf8").trim();
    if (!name) {
      process.stderr.write("Active profile file is empty.\n");
      process.exitCode = 2;
      return;
    }
    let profile: Profile;
    try {
      profile = loadProfile(name, home);
    } catch (e) {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 2;
      return;
    }
    let transport;
    try {
      transport = await resolveTransportEndpoint(profile, home);
    } catch (e) {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 2;
      return;
    }
    process.stdout.write(`profile current: name=${profile.name}\n`);
    process.stdout.write(
      `profile current: transport=${profile.transport} lifecycle=${profile.lifecycle}\n`,
    );
    if (profile.lifecycle === "compose") {
      if (profile.instance_id !== undefined) {
        process.stdout.write(`profile current: instance_id=${profile.instance_id}\n`);
      }
    }
    process.stdout.write(`profile current: baseUrl=${transport.baseUrl}\n`);
    if (transport.unixSocketPath) {
      process.stdout.write(`profile current: unixSocket=${transport.unixSocketPath}\n`);
    }
    if (profile.transport === "remote") {
      const tokenExists = existsSync(bootstrapTokenPath(profile.name, home));
      process.stdout.write(
        tokenExists
          ? "profile current: bootstrapToken=present (value hidden)\n"
          : profile.lifecycle === "compose"
            ? "profile current: bootstrapToken=absent (not required for day-two SSH lifecycle commands)\n"
            : "profile current: bootstrapToken=absent (required only for first-install setup API commands)\n",
      );
    }
    process.exitCode = 0;
  },
};

export const profileModule: CommandModule = {
  command: "profile",
  describe:
    "Create, select, inspect, and remove deployment profiles. Start with `profile add <name>` for an interactive setup.",
  builder: (yargs) =>
    yargs
      .command(listCmd)
      .command(addCmd)
      .command(useCmd)
      .command(setCmd)
      .command(removeCmd)
      .command(currentCmd)
      .example("$0 profile add production", "Create and activate a profile with the interactive wizard.")
      .epilogue("Docker Compose deploys use the latest signed stable image by default; pass `deploy --image <digest>` to select one explicitly. Guide: https://nautilo.ai/docs/operator/deploy/docker-compose")
      .demandCommand(1, "Specify a subcommand: add, use, set, list, remove, current"),
  handler: () => {
    process.stderr.write("Specify a profile subcommand (add, use, set, list, remove, current).\n");
    process.exitCode = 2;
  },
};
