import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CommandModule } from "yargs";
import type { RedeemResult, SecretField, SetupTemplate } from "@nautilo/api-client";
import { NautiloApiClient } from "@nautilo/api-client";
import { isCloudMode, resolveInstance } from "@nautilo/config";
import { applyGenieDefaults, type GenieSetupArgv } from "../lib/apply-genie-defaults.ts";
import { applyProviderEnvWrites } from "../lib/config-env.ts";
import {
  bootstrapAdminPasswordKey,
  bootstrapPinKey,
  bootstrapDirForInstance,
  claimInviteKey,
  defaultOperatorSecretsPath,
  loadOperatorSecrets,
  readBootstrapDir,
} from "@nautilo/operator-secrets";
import { requireLoopback } from "../lib/loopback-guard.ts";
import { extractRedeemBearer } from "../lib/redeem-claim.ts";
import {
  parseSetupTemplateFromPath,
  resolveSetupTemplate,
  type ResolvedSetupTemplate,
} from "../setup-template/loader.ts";
import { printQuickstartTemplate } from "../setup-template/print-template.ts";
import {
  apiClientOptionsFor,
  resolveServerForCommand,
  transportFetch,
} from "../lib/profile-aware-server.ts";

function shredTemplate(path: string): void {
  try {
    const size = statSync(path).size;
    writeFileSync(path, randomBytes(size));
  } catch {
    /* best effort */
  }
  unlinkSync(path);
}

async function pollUntilReady(
  api: NautiloApiClient,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await api.getSetupStatus();
    if (s.setupState === "ready") return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function genieArgvFromYargs(argv: Record<string, unknown>): GenieSetupArgv {
  return {
    randomizeGenie: argv["randomize-genie"] === true,
    seed: typeof argv["seed"] === "number" ? argv["seed"] : undefined,
    forceGenie: argv["force-genie"] === true,
  };
}

function applyRedeemToken(
  api: NautiloApiClient,
  redeem: {
    logtoSession?: { accessToken: string } | undefined;
    sessionToken?: string | undefined;
  },
): boolean {
  if (redeem.logtoSession?.accessToken) {
    api.setToken(redeem.logtoSession.accessToken);
    return true;
  }
  if (redeem.sessionToken) {
    api.setToken(redeem.sessionToken);
    return true;
  }
  return false;
}

function resolveInstanceId(filePath: string): string {
  const fromEnv = process.env["NAUTILO_INSTANCE_ID"]?.trim();
  if (fromEnv) return fromEnv;
  const m = filePath.match(/\.nautilo-([^/\\]+)[/\\]/);
  if (m?.[1]) return m[1];
  return "unknown";
}

function secretFieldLabel(field: SecretField | undefined, inlineLabel: string): string {
  if (field && "fromEnv" in field) return field.fromEnv;
  return inlineLabel;
}

function activeGenieRequested(parsed: SetupTemplate, argv: GenieSetupArgv): boolean {
  let g = parsed.genie;
  if (argv.randomizeGenie) {
    g = { ...(g ?? {}), mode: "randomize" } as NonNullable<SetupTemplate["genie"]>;
  }
  return !!(g && g.mode !== "skip");
}

function buildSetupSummaryBanner(args: {
  instanceId: string;
  setupState: string;
  parsed: SetupTemplate;
  resolved: ResolvedSetupTemplate;
  recoveryCodes: string[] | undefined;
  secretsFileUsed: string | undefined;
  providerApplied?: string[];
  providerRejected?: Array<{ key: string; error: string }>;
}): string {
  const opFile = args.secretsFileUsed ?? defaultOperatorSecretsPath();
  const pwLabel = secretFieldLabel(
    args.parsed.admin.password,
    "(inline in setup template)",
  );
  const pinLabel = secretFieldLabel(args.parsed.admin.pin, "(inline in setup template)");
  const lines: string[] = [];
  lines.push("═══════════════════════════════════════════════════════════");
  lines.push(`  Nautilo setup complete — ${args.instanceId}`);
  lines.push("═══════════════════════════════════════════════════════════");
  lines.push("");
  lines.push(`  setupState: ${args.setupState}`);
  lines.push("");
  lines.push("  Credentials applied:");
  lines.push(`    • admin handle ............ ${args.resolved.admin.handle}`);
  lines.push(`    • admin display name ...... ${args.resolved.admin.displayName}`);
  if (args.parsed.admin.password && "fromEnv" in args.parsed.admin.password) {
    lines.push(`    • admin password .......... ${pwLabel}`);
    lines.push(`                                 (in ${opFile})`);
  } else {
    lines.push(`    • admin password .......... ${pwLabel}`);
  }
  if (args.parsed.admin.pin && "fromEnv" in args.parsed.admin.pin) {
    lines.push(`    • admin PIN ............... ${pinLabel}`);
    lines.push(`                                 (in ${opFile})`);
  } else {
    lines.push(`    • admin PIN ............... ${pinLabel}`);
  }
  lines.push(`    • Logto admin password .... ~/.nautilo-${args.instanceId}/logto-admin.txt`);
  const applied = args.providerApplied ?? args.resolved.providers.map((p) => p.key);
  const rejected = args.providerRejected ?? [];
  lines.push(`    • provider keys applied ... ~/.nautilo-${args.instanceId}/instance.env`);
  lines.push(`                                 (${applied.length > 0 ? applied.join(", ") : "none"})`);
  if (rejected.length > 0) {
    lines.push(`    • provider keys REJECTED .. ${rejected.length}`);
    for (const r of rejected) {
      lines.push(`        ! ${r.key}: ${r.error}`);
    }
  }
  lines.push("");
  if (args.recoveryCodes && args.recoveryCodes.length > 0) {
    lines.push("  Recovery codes (one-time, store now — won't be shown again):");
    lines.push(`    ${args.recoveryCodes.join("  ")}`);
    lines.push("");
  }
  lines.push("  Next: nautilo login (administrator sign-in)");
  lines.push("═══════════════════════════════════════════════════════════");
  return `${lines.join("\n")}\n`;
}

function writeSetupSummaryFile(instanceId: string, body: string): void {
  const dir = join(homedir(), `.nautilo-${instanceId}`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    /* ignore */
  }
  const path = join(dir, "setup-summary.txt");
  writeFileSync(path, body, { mode: 0o600 });
  if (process.platform !== "win32") {
    try {
      chmodSync(path, 0o600);
    } catch {
      /* ignore */
    }
  }
}

export const setupModule: CommandModule = {
  command: "setup",
  describe: "Apply a setup template (claim invite, provider keys, Genie defaults)",
  builder: (yargs) =>
    yargs
      .option("file", {
        type: "string",
        describe: "Path to setup.toml or setup.json",
      })
      .option("delete-file", {
        type: "boolean",
        default: false,
        describe: "Secure-delete the template file after success",
      })
      .option("secrets-file", {
        type: "string",
        describe:
          "Operator secrets file (mode 0600) merged before fromEnv resolution; loopback servers only",
      })
      .option("randomize-genie", {
        type: "boolean",
        default: false,
        describe: "Force genie mode=randomize (honours pinned fields)",
      })
      .option("seed", {
        type: "number",
        describe: "Deterministic seed for Genie randomize (overrides template)",
      })
      .option("force-genie", {
        type: "boolean",
        default: false,
        describe: "Overwrite an existing customized Genie profile",
      })
      .option("print-template", {
        type: "boolean",
        default: false,
        describe: "Print the stock quickstart TOML to stdout",
      })
      .epilog(
        "Recovery-code safety: if claim redeem succeeds but no session token is returned, setup still prints and writes recovery codes to ~/.nautilo-<instance>/setup-summary.txt before exiting non-zero. Do not rerun blindly without saving those codes.",
      ),
  handler: async (argv) => {
    try {
      if (argv["print-template"]) {
        process.stdout.write(printQuickstartTemplate());
        process.exitCode = 0;
        return;
      }

      const filePath = argv["file"] as string | undefined;
      if (!filePath) {
        process.stderr.write(
          "missing setup file; pass --file <path> or use --print-template.\n",
        );
        process.exitCode = 2;
        return;
      }

      const parsedSetup = parseSetupTemplateFromPath(filePath);
      const transport = await resolveServerForCommand({
        serverFlag: (argv["server"] as string | undefined) ?? undefined,
        templateServerUrl: parsedSetup.serverUrl,
      });

      // setup is intentionally a same-host operation in Milestone A.
      // If an active profile resolves to a non-local target, error out.
      if (transport.source === "profile") {
        const isLocalhost =
          transport.baseUrl.includes("localhost") ||
          transport.baseUrl.includes("127.0.0.1") ||
          transport.baseUrl.includes("::1");
        if (!isLocalhost && !transport.unixSocketPath) {
          process.stderr.write(
            "nautilo setup runs on the host where the server lives; use docker-compose driver or SSH to the server and run setup there\n",
          );
          process.exitCode = 2;
          return;
        }
      }

      const serverUrl = transport.baseUrl;
      // Loopback guard: a Unix socket is implicitly local (no network leg),
      // so requireLoopback() — which inspects host strings — is bypassed
      // when the transport is socket-bound. For TCP transports we still
      // assert loopback before mutating identity / writing secrets.
      if (transport.unixSocketPath === undefined) {
        requireLoopback(serverUrl);
      }

      const secretsArg = argv["secrets-file"];
      const secretsPath =
        typeof secretsArg === "string" && secretsArg.trim().length > 0
          ? secretsArg.trim()
          : undefined;
      const secretsMap = secretsPath ? await loadOperatorSecrets(secretsPath) : {};

      const fromPath = resolveInstanceId(filePath);
      const currentInstanceId =
        process.env["NAUTILO_INSTANCE_ID"]?.trim() ||
        (fromPath !== "unknown" ? fromPath : resolveInstance().instanceId);

      const bootstrapSnapshot = readBootstrapDir(
        bootstrapDirForInstance(currentInstanceId),
      );

      const envLookup = (name: string): string | undefined => {
        if (name === bootstrapAdminPasswordKey(currentInstanceId)) {
          const v = bootstrapSnapshot.adminPassword ?? undefined;
          if (v !== undefined && v.length > 0) return v;
        } else if (name === bootstrapPinKey(currentInstanceId)) {
          const v = bootstrapSnapshot.adminPin ?? undefined;
          if (v !== undefined && v.length > 0) return v;
        } else if (name === claimInviteKey(currentInstanceId)) {
          const v = bootstrapSnapshot.claimInvite ?? undefined;
          if (v !== undefined && v.length > 0) return v;
        }

        const fromFile = secretsMap[name];
        if (fromFile !== undefined && String(fromFile).trim().length > 0) {
          return String(fromFile).trim();
        }
        const fromProc = process.env[name]?.trim();
        return fromProc && fromProc.length > 0 ? fromProc : undefined;
      };

      const template = resolveSetupTemplate(parsedSetup, envLookup);

      const api = new NautiloApiClient(serverUrl, apiClientOptionsFor(transport));
      const status = await api.getSetupStatus();

      const gArgv = genieArgvFromYargs(argv as Record<string, unknown>);

      if (status.setupState === "ready") {
        process.stderr.write(
          "setupState is already ready; skipping claim and provider key writes.\n",
        );
        await applyGenieDefaults({
          transport,
          api,
          template,
          argv: gArgv,
          redeemBearer: null,
        });
        process.exitCode = 0;
        const instanceId = resolveInstanceId(filePath);
        const banner = buildSetupSummaryBanner({
          instanceId,
          setupState: "ready",
          parsed: parsedSetup,
          resolved: template,
          recoveryCodes: undefined,
          secretsFileUsed: secretsPath,
        });
        process.stdout.write(banner);
        writeSetupSummaryFile(instanceId, banner);
        if (argv["delete-file"]) shredTemplate(filePath);
        return;
      }

      if (status.setupState === "claimed-needs-auth") {
        if (activeGenieRequested(parsedSetup, gArgv)) {
          process.stderr.write(
            "[setup] genie defaults skipped (no bearer; sign in and use /genie or run setup against a fresh-unclaimed instance)\n",
          );
        }
        process.stderr.write(
          "setupState=claimed-needs-auth — complete owner sign-in via Workbench, the Desktop app, or `nautilo login`, then retry.\n",
        );
        process.exitCode = 2;
        return;
      }

      let redeemBearer: string | null = null;
      let recoveryCodes: string[] | undefined;

      if (status.setupState === "fresh-unclaimed") {
        const redeem: RedeemResult = await api.redeemInvite(template.claim.inviteCode.value, {
          handle: template.admin.handle,
          displayName: template.admin.displayName,
          password: template.admin.password.value,
          pin: template.admin.pin.value,
          forcePasswordChange: false,
        });
        recoveryCodes = redeem.recoveryCodes;

        if (!applyRedeemToken(api, redeem)) {
          const instanceId = resolveInstanceId(filePath);
          const afterRedeemState = await api
            .getSetupStatus()
            .then((s) => s.setupState)
            .catch(() => "claimed-needs-auth");
          const banner = buildSetupSummaryBanner({
            instanceId,
            setupState: afterRedeemState,
            parsed: parsedSetup,
            resolved: template,
            recoveryCodes,
            secretsFileUsed: secretsPath,
            providerApplied: [],
            providerRejected: [],
          });
          process.stdout.write(banner);
          writeSetupSummaryFile(instanceId, banner);
          process.stderr.write(
            "claim succeeded and recovery codes were written, but redeem did not return a session token — cannot continue automation.\n",
          );
          process.stderr.write(
            "Complete owner sign-in manually, then rerun setup if provider keys still need to be applied.\n",
          );
          process.exitCode = 2;
          return;
        }
        redeemBearer = extractRedeemBearer(redeem);
      }

      // Order matters: apply Genie defaults BEFORE provider key writes.
      // Genie only needs the redeem bearer (just minted, in-memory). Provider
      // keys are local file writes that may reject individual keys (stale
      // token, format mismatch, dead provider endpoint). A bad provider key
      // must not block Genie from landing — they're independent surfaces.
      await applyGenieDefaults({
        transport,
        api,
        template,
        argv: gArgv,
        redeemBearer,
      });

      let providerResult: {
        applied: string[];
        rejected: Array<{ key: string; error: string }>;
      } = { applied: [], rejected: [] };

      if (template.providers.length > 0) {
        if (isCloudMode()) {
          process.stderr.write(
            "[setup] Cloud mode (NAUTILO_HOSTING_MODE=cloud) — provider keys must be set " +
              "via the container env, not via the setup CLI. Verifying env-side presence instead...\n",
          );
          try {
            const res = await transportFetch(transport, "/api/health/keys");
            if (!res.ok) {
              process.stderr.write(
                `[setup] could not read server key status (HTTP ${res.status}); ensure secrets are injected in the container env.\n`,
              );
            } else {
              const rows = (await res.json()) as Array<{
                envVar: string;
                status: string;
                masked: string | null;
              }>;
              for (const row of rows) {
                const masked = row.masked ? ` masked=${row.masked}` : "";
                process.stderr.write(`[setup]   ${row.envVar}: ${row.status}${masked}\n`);
              }
            }
          } catch (e) {
            process.stderr.write(
              `[setup] key status fetch failed (${e instanceof Error ? e.message : String(e)})\n`,
            );
          }
        } else {
          providerResult = await applyProviderEnvWrites({
            operations: template.providers.map((p) => ({
              key: p.key,
              value: p.value.value,
            })),
          });
        }
      }

      for (const r of providerResult.rejected) {
        process.stderr.write(`[setup] provider ${r.key} rejected: ${r.error}\n`);
      }
      if (providerResult.applied.length > 0) {
        process.stderr.write(
          `[setup] provider keys applied (${providerResult.applied.length}): ${providerResult.applied.join(", ")}\n`,
        );
      }

      // D112 Phase 19.1 — ask the running server to re-read
      // `instance.env` so the keys we just wrote are visible to the
      // agent runtime on the very next chat turn (no manual restart).
      // Best-effort: a 404 means the server is older than this CLI
      // (no endpoint registered) and the operator will need to bounce
      // it manually as before; a 401/403 means our redeem bearer was
      // rejected (rare, but log + continue rather than failing setup
      // for a key-rotation step).
      //
      // D120 A5 follow-up — `/api/setup/reload-env` is loopback-only
      // (see route comment + ISSUE-D131). We only reach this branch
      // when `applyProviderEnvWrites` succeeded, which itself runs
      // only in non-cloud-mode (the cloud branch above takes a
      // different path). That makes the call implicitly loopback-only
      // on the local host. The explicit `transport.unixSocketPath ||
      // loopback` guard below is belt-and-braces: if a future change
      // ever lets provider writes happen against a remote target, we
      // still don't issue a reload-env POST that the route will refuse.
      const transportIsLoopback =
        transport.unixSocketPath !== undefined ||
        transport.baseUrl.includes("127.0.0.1") ||
        transport.baseUrl.includes("localhost") ||
        transport.baseUrl.includes("::1");
      if (providerResult.applied.length > 0 && redeemBearer && transportIsLoopback) {
        try {
          const reloadRes = await transportFetch(transport, "/api/setup/reload-env", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${redeemBearer}`,
            },
            body: "{}",
          });
          if (reloadRes.ok) {
            process.stderr.write("[setup] running server reloaded instance.env (keys live)\n");
          } else if (reloadRes.status === 404) {
            process.stderr.write(
              "[setup] server build predates /api/setup/reload-env; restart the server to pick up new keys\n",
            );
          } else {
            process.stderr.write(
              `[setup] instance.env reload returned ${reloadRes.status}; restart the server to pick up new keys\n`,
            );
          }
        } catch (e) {
          process.stderr.write(
            `[setup] instance.env reload skipped (${e instanceof Error ? e.message : String(e)}); restart the server to pick up new keys\n`,
          );
        }
      } else if (providerResult.applied.length > 0 && redeemBearer && !transportIsLoopback) {
        process.stderr.write(
          "[setup] remote target detected — instance.env reload is available only on the server itself; restart the server to pick up new keys\n",
        );
      }

      const ready = await pollUntilReady(api, 30_000);
      const finalState = ready ? "ready" : await api.getSetupStatus().then((s) => s.setupState);
      if (!ready) {
        process.stderr.write(
          `[setup] setupState=${finalState} (not yet ready). If you expected ready, sign in to clear claimed-needs-auth or add a valid OPENAI_API_KEY to clear server-needs-keys.\n`,
        );
      } else {
        process.stderr.write("nautilo setup completed (setupState=ready).\n");
      }

      // Exit codes:
      //   0 — claim succeeded, all providers applied (or none requested), ready
      //       OR claim succeeded but server-needs-keys / claimed-needs-auth (expected
      //       intermediate states pending sign-in / key entry).
      //   1 — claim succeeded but at least one provider key was rejected (warnings).
      //   2 — set on caught throws below (claim itself failed).
      process.exitCode = providerResult.rejected.length > 0 ? 1 : 0;
      const instanceId = resolveInstanceId(filePath);
      const banner = buildSetupSummaryBanner({
        instanceId,
        setupState: finalState,
        parsed: parsedSetup,
        resolved: template,
        recoveryCodes,
        secretsFileUsed: secretsPath,
        providerApplied: providerResult.applied,
        providerRejected: providerResult.rejected,
      });
      process.stdout.write(banner);
      writeSetupSummaryFile(instanceId, banner);
      if (argv["delete-file"]) shredTemplate(filePath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`${msg}\n`);
      process.exitCode = 2;
    }
  },
};
