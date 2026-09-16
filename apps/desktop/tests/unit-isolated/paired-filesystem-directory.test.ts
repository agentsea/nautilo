import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPairedFilesystemDirectoryAuthority } from "../../electron/paired-filesystem-directory";

const cleanup: string[] = [];
function tempRoot(): string {
  // Keep this fixture out of macOS's `/var/folders` and `/private` temp
  // hierarchies because the production picker intentionally hides both.
  // A worktree itself may legitimately live under `/private/tmp`, so the
  // fixture must not inherit its location from process.cwd().
  const root = mkdtempSync(join(homedir(), ".paired-filesystem-directory-"));
  cleanup.push(root);
  return root;
}
afterEach(() => { while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true }); });

function fixture() {
  const root = tempRoot();
  const home = join(root, "home");
  const data = join(root, "data");
  mkdirSync(join(home, "Documents", "Nautilo"), { recursive: true });
  mkdirSync(join(data, "Projects", "alpha"), { recursive: true });
  mkdirSync(join(data, "Data", "shared"), { recursive: true });
  mkdirSync(join(data, "System"), { recursive: true });
  mkdirSync(join(data, "Users"), { recursive: true });
  mkdirSync(join(data, "Volumes"), { recursive: true });
  mkdirSync(join(data, "cores"), { recursive: true });
  mkdirSync(join(data, "private"), { recursive: true });
  mkdirSync(join(data, "usr"), { recursive: true });
  symlinkSync(join(data, "Projects"), join(data, "shortcut"));
  const authority = createPairedFilesystemDirectoryAuthority({
    getHomeDirectory: () => home,
    getLocationCandidates: () => [
      { label: "Home", path: home },
      { label: "Macintosh HD — Data", path: data },
    ],
    // This fixture makes system and private folders unavailable while allowing
    // broad roots to be browsed (real policy is stricter at final selection).
    protectedPathPolicy: { check: (candidate) => ({ allowed: !candidate.endsWith("/System") }) },
    checkCurrentFolderSanity: (candidate) => ({ ok: candidate !== realpathSync(home) }),
    createLocationId: (() => { let n = 0; return () => `loc_${++n}`; })(),
  });
  return { authority, home, data };
}

describe("paired filesystem directory authority", () => {
  test("returns stable opaque location ids and never host paths", async () => {
    const { authority, home, data } = fixture();
    const first = await authority.list({ relativePath: "", limit: 100, includeHidden: false, query: "" });
    const second = await authority.list({ relativePath: "", limit: 100, includeHidden: false, query: "" });
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(JSON.stringify(first)).not.toContain(home);
    expect(JSON.stringify(first)).not.toContain(data);
    expect(first.entries.map((entry) => entry.path)).toEqual(["loc_1", "loc_2"]);
  });

  test("lists only non-symlink directories and blocks protected hierarchy names", async () => {
    const { authority } = fixture();
    const roots = await authority.list({ relativePath: "", limit: 100, includeHidden: false, query: "" });
    if (!roots.ok) throw new Error("roots unavailable");
    const data = roots.entries.find((entry) => entry.name === "Macintosh HD — Data");
    if (!data) throw new Error("Data unavailable");
    const listing = await authority.list({ relativePath: data.path, limit: 100, includeHidden: false, query: "" });
    expect(listing).toEqual({
      ok: true,
      entries: [
        { name: "Data", path: `${data.path}/Data`, isDirectory: true, isFile: false, isSymbolicLink: false },
        { name: "Projects", path: `${data.path}/Projects`, isDirectory: true, isFile: false, isSymbolicLink: false },
      ],
      nextCursor: null,
    });
  });

  test("permits the Data volume's user Data tree while filtering its OS mirrors", async () => {
    const { authority } = fixture();
    const roots = await authority.list({ relativePath: "", limit: 100, includeHidden: false, query: "" });
    if (!roots.ok) throw new Error("roots unavailable");
    const data = roots.entries.find((entry) => entry.name === "Macintosh HD — Data");
    if (!data) throw new Error("Data unavailable");
    const listed = await authority.list({ relativePath: data.path, limit: 100, includeHidden: false, query: "" });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.entries.map((entry) => entry.name)).toContain("Data");
    expect(listed.entries.map((entry) => entry.name)).not.toContain("System");
    expect(listed.entries.map((entry) => entry.name)).not.toContain("Users");
    expect(listed.entries.map((entry) => entry.name)).not.toContain("Volumes");
    expect(listed.entries.map((entry) => entry.name)).not.toContain("cores");
    expect(listed.entries.map((entry) => entry.name)).not.toContain("private");
    expect(listed.entries.map((entry) => entry.name)).not.toContain("usr");
  });

  test("rejects selecting Home itself but accepts a home subdirectory", async () => {
    const { authority } = fixture();
    const roots = await authority.list({ relativePath: "", limit: 100, includeHidden: false, query: "" });
    if (!roots.ok) throw new Error("roots unavailable");
    const home = roots.entries.find((entry) => entry.name === "Home");
    if (!home) throw new Error("Home unavailable");
    expect(await authority.select(home.path)).toEqual({ ok: false, error: "Choose a folder inside this location." });
    expect(await authority.select(`${home.path}/Documents`)).toMatchObject({ ok: true, label: "Documents" });
  });
});
