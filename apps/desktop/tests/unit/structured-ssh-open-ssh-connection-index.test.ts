import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  OPEN_SSH_CONNECTION_INDEX_MAX_DEPTH,
  OPEN_SSH_CONNECTION_INDEX_MAX_RECORDS,
  resolveOpenSshFiniteAlias,
} from "../../electron/structured-ssh/open-ssh-connection-index.ts";

const roots: string[] = [];
function fixture(): { home: string; ssh: string } {
  const home = mkdtempSync(join(tmpdir(), "nautilo-ssh-index-"));
  roots.push(home);
  const ssh = join(home, ".ssh");
  mkdirSync(ssh, { recursive: true, mode: 0o700 });
  return { home, ssh };
}
function source(path: string, contents: string): void { writeFileSync(path, contents, { mode: 0o600 }); }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("OpenSSH finite-alias index", () => {
  test("expands Includes at their directive point in lexical order and makes duplicate declarations ambiguous", async () => {
    const { home, ssh } = fixture();
    mkdirSync(join(ssh, "conf.d"));
    source(join(ssh, "config"), "Include conf.d/*.conf\nHost before\nHost after\n");
    source(join(ssh, "conf.d", "z.conf"), "Host alpha\n");
    source(join(ssh, "conf.d", "a.conf"), "Host ALPHA other\n");
    const result = await resolveOpenSshFiniteAlias("alpha", { homeDirectory: home });
    expect(result).toEqual({
      ok: true,
      records: [{ aliases: ["alpha", "other"] }, { aliases: ["alpha"] }],
      observed: { configFiles: 3, hostRecords: 4, bytes: expect.any(Number) },
    });
  });

  test("honors quoted include paths, comments, and escapes without treating wildcard Host patterns as records", async () => {
    const { home, ssh } = fixture();
    mkdirSync(join(ssh, "conf.d"));
    source(join(ssh, "config"), 'Include "conf.d/alpha\\ file.conf" # comment\nHost *.example.test !blocked\n');
    source(join(ssh, "conf.d", "alpha file.conf"), 'Host "alpha" # a finite alias\n');
    await expect(resolveOpenSshFiniteAlias("alpha", { homeDirectory: home })).resolves.toMatchObject({ ok: true, records: [{ aliases: ["alpha"] }], observed: { configFiles: 2, hostRecords: 1 } });
  });

  test("processes Include only in the ordered active Host scope", async () => {
    const inactive = fixture();
    source(join(inactive.ssh, "config"), "Host other\n  Include alpha.conf\n");
    source(join(inactive.ssh, "alpha.conf"), "Host alpha\n");
    await expect(resolveOpenSshFiniteAlias("alpha", { homeDirectory: inactive.home })).resolves.toMatchObject({ ok: true, records: [], observed: { configFiles: 1, hostRecords: 1 } });

    const active = fixture();
    source(join(active.ssh, "config"), "Host a* !museum\n  Include alpha.conf\n");
    source(join(active.ssh, "alpha.conf"), "Host alpha\n");
    await expect(resolveOpenSshFiniteAlias("alpha", { homeDirectory: active.home })).resolves.toMatchObject({ ok: true, records: [{ aliases: ["alpha"] }], observed: { configFiles: 2, hostRecords: 1 } });
  });

  test("does not expose negated exact aliases or wildcard-only option context", async () => {
    const negated = fixture(); source(join(negated.ssh, "config"), "Host alpha !alpha\n  User deploy\n");
    await expect(resolveOpenSshFiniteAlias("alpha", { homeDirectory: negated.home })).resolves.toMatchObject({ ok: true, records: [], observed: { hostRecords: 1 } });
    const wildcard = fixture(); source(join(wildcard.ssh, "config"), "Host *\n  User deploy\n");
    await expect(resolveOpenSshFiniteAlias("alpha", { homeDirectory: wildcard.home })).resolves.toMatchObject({ ok: true, records: [], observed: { hostRecords: 0 } });
  });

  test("carries included-file active state into post-Include ordering", async () => {
    const { home, ssh } = fixture();
    source(join(ssh, "config"), "Host alpha\n  Include state.conf\n  Include hidden.conf\nHost alpha\n  Include visible.conf\n");
    source(join(ssh, "state.conf"), "Host other\n");
    source(join(ssh, "hidden.conf"), "Host alpha\n");
    source(join(ssh, "visible.conf"), "Host alpha\n");
    await expect(resolveOpenSshFiniteAlias("alpha", { homeDirectory: home })).resolves.toMatchObject({
      ok: true,
      records: [{ aliases: ["alpha"] }, { aliases: ["alpha"] }, { aliases: ["alpha"] }],
      observed: { configFiles: 3, hostRecords: 4 },
    });
  });

  test("fails closed for Match, cycles, depth, symlinked and unreadable sources", async () => {
    const match = fixture(); source(join(match.ssh, "config"), "Match all\n  User deploy\n");
    await expect(resolveOpenSshFiniteAlias("alpha", { homeDirectory: match.home })).resolves.toMatchObject({ ok: false, code: "openssh_connection_catalog_unsupported_match", complete: false, phase: "openssh_catalog" });

    const cycle = fixture(); source(join(cycle.ssh, "config"), "Include a.conf\n"); source(join(cycle.ssh, "a.conf"), "Include config\n");
    await expect(resolveOpenSshFiniteAlias("alpha", { homeDirectory: cycle.home })).resolves.toMatchObject({ ok: false, code: "openssh_connection_catalog_malformed", complete: false });

    const depth = fixture();
    for (let index = 0; index <= OPEN_SSH_CONNECTION_INDEX_MAX_DEPTH; index += 1) source(join(depth.ssh, `${index}.conf`), index === OPEN_SSH_CONNECTION_INDEX_MAX_DEPTH ? "Host alpha\n" : `Include ${index + 1}.conf\n`);
    source(join(depth.ssh, "config"), "Include 0.conf\n");
    await expect(resolveOpenSshFiniteAlias("alpha", { homeDirectory: depth.home })).resolves.toMatchObject({ ok: false, code: "openssh_connection_catalog_overflow", configuredBound: { includeDepth: OPEN_SSH_CONNECTION_INDEX_MAX_DEPTH } });

    const linked = fixture(); const outside = join(linked.home, "outside.conf"); source(outside, "Host alpha\n"); symlinkSync(outside, join(linked.ssh, "config"));
    const linkedResult = await resolveOpenSshFiniteAlias("alpha", { homeDirectory: linked.home });
    expect(linkedResult).toMatchObject({ ok: false, code: "openssh_connection_catalog_unreadable", complete: false });
    expect(JSON.stringify(linkedResult)).not.toContain("outside.conf");

    const component = fixture(); const realDirectory = join(component.ssh, "real"); mkdirSync(realDirectory); source(join(realDirectory, "alpha.conf"), "Host alpha\n"); symlinkSync(realDirectory, join(component.ssh, "linked")); source(join(component.ssh, "config"), "Include linked/alpha.conf\n");
    await expect(resolveOpenSshFiniteAlias("alpha", { homeDirectory: component.home })).resolves.toMatchObject({ ok: false, code: "openssh_connection_catalog_unreadable", complete: false });

    const unreadable = fixture(); mkdirSync(join(unreadable.ssh, "config"));
    await expect(resolveOpenSshFiniteAlias("alpha", { homeDirectory: unreadable.home })).resolves.toMatchObject({ ok: false, code: "openssh_connection_catalog_unreadable", complete: false });
  });

  test("reports record overflow instead of returning a false not-found", async () => {
    const { home, ssh } = fixture();
    source(join(ssh, "config"), Array.from({ length: OPEN_SSH_CONNECTION_INDEX_MAX_RECORDS + 1 }, (_, index) => `Host alias-${index}`).join("\n"));
    await expect(resolveOpenSshFiniteAlias("alpha", { homeDirectory: home })).resolves.toMatchObject({ ok: false, code: "openssh_connection_catalog_overflow", complete: false, configuredBound: { hostRecords: OPEN_SSH_CONNECTION_INDEX_MAX_RECORDS } });
  });
});
