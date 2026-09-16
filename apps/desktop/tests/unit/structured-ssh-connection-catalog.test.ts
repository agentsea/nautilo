import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NAUTILO_SSH_PROFILE_MAX_FILES, resolveNautiloSshConnection } from "../../electron/structured-ssh/connection-catalog.ts";

const roots: string[] = [];
function fixture(): { home: string; profiles: string } {
  const home = mkdtempSync(join(tmpdir(), "nautilo-ssh-catalog-")); roots.push(home);
  const profiles = join(home, ".nautilo", "profiles"); mkdirSync(profiles, { recursive: true, mode: 0o700 }); return { home, profiles };
}
function profile(name = "alpha", domain = "alpha.example.test", host = "192.0.2.10"): string {
  return [`name = "${name}"`, 'transport = "remote"', `domain = "${domain}"`, "", "[ssh]", `host = "${host}"`, 'user = "root"', 'identity_file = "~/.ssh/qa_deploy_ed25519"', 'known_hosts_file = "~/.ssh/known_hosts"', "port = 2222", ""].join("\n");
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Nautilo structured SSH connection catalog", () => {
  test("returns one complete profile candidate with safe provenance", async () => {
    const { home, profiles } = fixture(); writeFileSync(join(profiles, "alpha.toml"), profile(), { mode: 0o600 });
    await expect(resolveNautiloSshConnection("alpha", { homeDirectory: home })).resolves.toMatchObject({
      ok: true, observed: { profileFiles: 1, matchingProfiles: 1, bytes: profile().length }, connections: [{ source: { kind: "nautilo-profile", name: "alpha" }, destination: { host: "192.0.2.10", remoteUser: "root", port: 2222 }, identityFile: "~/.ssh/qa_deploy_ed25519", knownHostsFile: "~/.ssh/known_hosts" }],
    });
  });

  test("reports zero and multiple profile candidates distinctly", async () => {
    const { home, profiles } = fixture(); writeFileSync(join(profiles, "first.toml"), profile("first"), { mode: 0o600 }); writeFileSync(join(profiles, "second.toml"), profile("second"), { mode: 0o600 });
    await expect(resolveNautiloSshConnection("other", { homeDirectory: home })).resolves.toMatchObject({ ok: true, connections: [], observed: { profileFiles: 2, matchingProfiles: 0, bytes: profile("first").length + profile("second").length } });
    await expect(resolveNautiloSshConnection("alpha.example.test", { homeDirectory: home })).resolves.toMatchObject({ ok: false, code: "connection_ambiguous", observed: { profileFiles: 2, matchingProfiles: 2 }, complete: false, retrySafe: true, stateChanged: false, recovery: "choose_connection" });
  });

  test("makes malformed, symlinked, and overflow profile sources truthful without leaking paths", async () => {
    const malformed = fixture(); writeFileSync(join(malformed.profiles, "alpha.toml"), 'transport = "remote"\n[ssh]\nuser = "root"\n', { mode: 0o600 });
    await expect(resolveNautiloSshConnection("alpha", { homeDirectory: malformed.home })).resolves.toMatchObject({ ok: false, code: "connection_catalog_malformed", phase: "profile_catalog", complete: false, retrySafe: true, stateChanged: false, recovery: "repair_profile" });
    const linked = fixture(); const outside = join(linked.home, "outside.toml"); writeFileSync(outside, profile(), { mode: 0o600 }); symlinkSync(outside, join(linked.profiles, "alpha.toml"));
    await expect(resolveNautiloSshConnection("alpha", { homeDirectory: linked.home })).resolves.toMatchObject({ ok: false, code: "connection_catalog_unreadable", phase: "profile_catalog", complete: false, retrySafe: true, stateChanged: false, recovery: "repair_profile" });
    const unrelatedBroken = fixture(); writeFileSync(join(unrelatedBroken.profiles, "alpha.toml"), profile(), { mode: 0o600 }); symlinkSync(outside, join(unrelatedBroken.profiles, "other.toml"));
    const unsafe = await resolveNautiloSshConnection("alpha", { homeDirectory: unrelatedBroken.home });
    expect(unsafe).toMatchObject({ ok: false, code: "connection_catalog_unreadable", observed: { profileFiles: 2 }, complete: false });
    expect(JSON.stringify(unsafe)).not.toContain("outside.toml");
    const overflow = fixture(); for (let index = 0; index <= NAUTILO_SSH_PROFILE_MAX_FILES; index += 1) writeFileSync(join(overflow.profiles, `profile-${index}.toml`), profile(`profile-${index}`), { mode: 0o600 });
    await expect(resolveNautiloSshConnection("none", { homeDirectory: overflow.home })).resolves.toMatchObject({ ok: false, code: "connection_catalog_overflow", observed: { profileFiles: NAUTILO_SSH_PROFILE_MAX_FILES + 1 }, configuredBound: { profileFiles: NAUTILO_SSH_PROFILE_MAX_FILES }, complete: false, retrySafe: true, stateChanged: false, recovery: "reduce_catalog" });
  });
});
