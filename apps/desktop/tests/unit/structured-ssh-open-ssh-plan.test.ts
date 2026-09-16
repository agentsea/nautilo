import { describe, expect, test } from "bun:test";

import { SYSTEM_OPENSSH_PATHS, type StructuredSshProcessResult } from "../../electron/structured-ssh/process-runner.ts";
import { OPEN_SSH_NAMED_CONNECTION_PROBE_SENTINEL, resolveOpenSshDestinationPlan, type OpenSshPlanRunnerInput } from "../../electron/structured-ssh/open-ssh-plan.ts";

const exited = (stdout: string): StructuredSshProcessResult => ({ processStarted: true, termination: "exited", code: 0, signal: null, stdout, stderr: "" });
const SAFETY = ["proxycommand none", "proxyjump none", "forwardagent no", "permitlocalcommand no", "localcommand none", "localforward none", "remoteforward none", "dynamicforward none", "canonicalizehostname false", "controlmaster false", "controlpath none", "remotecommand none", "knownhostscommand none"];
function config({ host = "alpha.example.test", user = "deploy", port = 22, identity = "~/.ssh/id_ed25519", extra = [] }: { host?: string; user?: string; port?: number; identity?: string; extra?: readonly string[] } = {}): string {
  return ["host alpha", `hostname ${host}`, `user ${user}`, `port ${port}`, `identityfile ${identity}`, "userknownhostsfile ~/.ssh/known_hosts", ...SAFETY, ...extra, ""].join("\n");
}
const emptyIndex = async () => ({ ok: true as const, records: [], observed: { configFiles: 0, hostRecords: 0, bytes: 0 } });
const namedIndex = async () => ({ ok: true as const, records: [{ aliases: ["alpha"] }], observed: { configFiles: 1, hostRecords: 1, bytes: 20 } });
const noProfiles = async () => ({ ok: true as const, connections: [], observed: { profileFiles: 0, matchingProfiles: 0, bytes: 0 } });
const profile = {
  source: { kind: "nautilo-profile" as const, name: "alpha" },
  destination: { host: "192.0.2.10", remoteUser: "root", port: 2222 },
  identityFile: "~/.ssh/qa_deploy_ed25519",
  knownHostsFile: "~/.ssh/qa_known_hosts",
};

describe("OpenSSH destination-plan resolver", () => {
  test("ad hoc endpoints bypass named readers, retain exact destination, and refuse OpenSSH rewrites", async () => {
    const calls: OpenSshPlanRunnerInput[] = [];
    const selected = await resolveOpenSshDestinationPlan({ host: "build.example.test", user: "deploy", port: 2222 }, {
      resolveOpenSshConnection: async () => { throw new Error("must not read OpenSSH index"); },
      resolveNautiloConnection: async () => { throw new Error("must not read catalog"); },
      run: async (input) => { calls.push(input); return exited(config({ host: "build.example.test", user: "deploy", port: 2222 })); },
    });
    expect(selected).toMatchObject({ ok: true, summary: { connectionSource: { kind: "explicit" } } });
    expect(calls[0]?.argv).toEqual(["-G", "-l", "deploy", "-p", "2222", "--", "build.example.test"]);
    await expect(resolveOpenSshDestinationPlan({ host: "build.example.test", user: "deploy" }, {
      run: async () => exited(config({ host: "rewritten.example.test", user: "deploy" })),
    })).resolves.toMatchObject({ ok: false, failure: { phase: "policy", code: "config_destination_mismatch", retrySafe: true, sideEffectStarted: false, stateChanged: false, recovery: "correct_destination" } });
  });

  test("uses a finite OpenSSH declaration to prove a configured same-local User without exposing its sentinel", async () => {
    const calls: OpenSshPlanRunnerInput[] = [];
    const result = await resolveOpenSshDestinationPlan({ connection: "alpha" }, {
      resolveOpenSshConnection: namedIndex,
      resolveNautiloConnection: noProfiles,
      run: async (input) => { calls.push(input); return exited(config({ user: "writer" })); },
    });
    expect(result).toMatchObject({ ok: true, plan: { destination: { remoteUser: "writer" } }, summary: { connectionSource: { kind: "openssh", name: "alpha" } } });
    expect(calls[0]?.argv).toEqual(["-G", "-F", "/dev/stdin", "--", "alpha"]);
    expect(calls[0]?.stdin).toMatch(/^Include ~\/\.ssh\/config\nHost \*\n  User __nautilo_probe_[a-f0-9]{32}\n$/);
    expect(OPEN_SSH_NAMED_CONNECTION_PROBE_SENTINEL.test(calls[0]?.stdin?.split(" ").at(-1)?.trim() ?? "")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("__nautilo_probe_");
  });

  test("reports missing User only after the index proves the named OpenSSH record exists", async () => {
    const result = await resolveOpenSshDestinationPlan({ connection: "alpha" }, {
      resolveOpenSshConnection: namedIndex,
      resolveNautiloConnection: noProfiles,
      run: async (input) => exited(config({ host: "real.example.test", user: input.stdin!.match(/User ([^\n]+)/)?.[1] ?? "wrong" })),
    });
    expect(result).toMatchObject({ ok: false, failure: { phase: "resolve", code: "remote_user_missing", retrySafe: true, sideEffectStarted: false, stateChanged: false, recovery: "provide_remote_user" } });
    const unknown = await resolveOpenSshDestinationPlan({ connection: "unknown" }, {
      resolveOpenSshConnection: emptyIndex,
      resolveNautiloConnection: noProfiles,
      run: async () => { throw new Error("zero records must not probe"); },
    });
    expect(unknown).toMatchObject({ ok: false, failure: { phase: "catalog", code: "connection_not_found", retrySafe: true, sideEffectStarted: false, stateChanged: false, recovery: "choose_connection" } });
  });

  test("queries both readers before deciding and rejects duplicates within and across sources", async () => {
    const duplicateIndex = async () => ({ ok: true as const, records: [{ aliases: ["alpha"] }, { aliases: ["alpha", "other"] }], observed: { configFiles: 1, hostRecords: 2, bytes: 40 } });
    await expect(resolveOpenSshDestinationPlan({ connection: "alpha" }, {
      resolveOpenSshConnection: duplicateIndex,
      resolveNautiloConnection: async () => ({ ok: true as const, connections: [profile], observed: { profileFiles: 1, matchingProfiles: 1, bytes: 20 } }),
      run: async () => { throw new Error("ambiguous sources must not probe"); },
    })).resolves.toMatchObject({ ok: false, failure: { phase: "catalog", code: "connection_ambiguous", retrySafe: true, sideEffectStarted: false, stateChanged: false, recovery: "choose_connection", completeness: false, observed: { files: 2, records: 3, bytes: 60 }, candidates: [{ source: "openssh", name: "alpha" }, { source: "openssh", name: "alpha" }, { source: "nautilo-profile", name: "alpha" }] } });
  });

  test("uses profile destination and private hints alone and rejects its effective-config rewrite", async () => {
    const selected = await resolveOpenSshDestinationPlan({ connection: "alpha" }, {
      resolveOpenSshConnection: emptyIndex,
      resolveNautiloConnection: async () => ({ ok: true as const, connections: [profile], observed: { profileFiles: 1, matchingProfiles: 1 } }),
      run: async () => exited(config({ host: "192.0.2.10", user: "root", port: 2222, identity: "~/.ssh/ignored" })),
    });
    expect(selected).toMatchObject({ ok: true, plan: { identitySources: [{ kind: "file", identityFile: "~/.ssh/qa_deploy_ed25519" }], knownHostFiles: ["~/.ssh/qa_known_hosts"] }, summary: { connectionSource: { kind: "nautilo-profile", name: "alpha" } } });
    expect(JSON.stringify(selected)).not.toContain("ignored");
    await expect(resolveOpenSshDestinationPlan({ connection: "alpha" }, {
      resolveOpenSshConnection: emptyIndex,
      resolveNautiloConnection: async () => ({ ok: true as const, connections: [profile], observed: { profileFiles: 1, matchingProfiles: 1 } }),
      run: async () => exited(config({ host: "other.example.test", user: "root", port: 2222 })),
    })).resolves.toMatchObject({ ok: false, failure: { phase: "policy", code: "config_destination_mismatch" } });
  });

  test("rejects KnownHostsCommand and malformed mixed intent before any process starts", async () => {
    await expect(resolveOpenSshDestinationPlan({ host: "build.example.test", user: "deploy" }, {
      run: async () => exited(config({ host: "build.example.test" }).replace("knownhostscommand none", "knownhostscommand /bin/evil")),
    })).resolves.toMatchObject({ ok: false, failure: { phase: "policy", code: "config_unsafe_directive" } });
    const calls: OpenSshPlanRunnerInput[] = [];
    const dependencies = { run: async (input: OpenSshPlanRunnerInput) => { calls.push(input); return exited(config()); } };
    await expect(resolveOpenSshDestinationPlan({ connection: "alpha", host: "other", user: "deploy" }, dependencies)).resolves.toMatchObject({ ok: false, failure: { phase: "intent", code: "invalid_destination" } });
    expect(calls).toEqual([]);
  });
});
