import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import { createStructuredSshHostTrustBundle, type StructuredSshHostTrustFileSystem } from "../../electron/structured-ssh/identity-confinement.ts";

function sshString(value: Buffer | string): Buffer {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "ascii");
  const length = Buffer.alloc(4); length.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([length, bytes]);
}

function observedLine(host = "build.example.test", port = 22): string {
  const type = "ssh-ed25519";
  const blob = Buffer.concat([sshString(type), sshString(Buffer.alloc(32, 7))]);
  // Keep this realistic: the confinement validates the public host key.
  createHash("sha256").update(blob).digest("base64");
  return `${port === 22 ? host : `[${host}]:${port}`} ${type} ${blob.toString("base64")}`;
}

type NodeKind = "directory" | "file" | "symlink";
interface FakeNode { readonly kind: NodeKind; readonly dev: number; readonly ino: number; }
interface FakeFileSystem extends StructuredSshHostTrustFileSystem {
  readonly writes: Map<string, string>;
  readonly opens: { readonly path: string; readonly flags: string; readonly mode: number }[];
  readonly removes: { readonly path: string; readonly recursive: boolean | undefined }[];
  replaceRunDirectory(): void;
  replaceKnownHostsFile(): void;
  file(path: string): void;
}

function errno(code: string): NodeJS.ErrnoException { const error = new Error(code) as NodeJS.ErrnoException; error.code = code; return error; }

function fakeFileSystem(): FakeFileSystem {
  const nodes = new Map<string, FakeNode>();
  const writes = new Map<string, string>();
  const opens: { path: string; flags: string; mode: number }[] = [];
  const removes: { path: string; recursive: boolean | undefined }[] = [];
  let nextIno = 1;
  const add = (path: string, kind: NodeKind) => nodes.set(path, { kind, dev: 1, ino: nextIno++ });
  add("/app-data", "directory"); add("/app data", "directory");
  const stat = (node: FakeNode) => ({ isDirectory: () => node.kind === "directory", isFile: () => node.kind === "file", isSymbolicLink: () => node.kind === "symlink", dev: node.dev, ino: node.ino });
  return {
    writes, opens, removes,
    file: (path) => add(path, "file"),
    replaceRunDirectory: () => { for (const path of nodes.keys()) if (path.includes("structured-ssh-run-")) add(path, "directory"); },
    replaceKnownHostsFile: () => { for (const path of nodes.keys()) if (path.endsWith("/known_hosts")) add(path, "file"); },
    async mkdir(path, options) { if (!options.recursive && nodes.has(path)) throw errno("EEXIST"); add(path, "directory"); },
    async lstat(path) { const node = nodes.get(path); if (!node) throw errno("ENOENT"); return stat(node); },
    async realpath(path) { const node = nodes.get(path); if (!node) throw errno("ENOENT"); return node.kind === "symlink" ? `${path}-target` : path; },
    async open(path, flags, mode) {
      if (nodes.has(path)) throw errno("EEXIST"); opens.push({ path, flags, mode }); add(path, "file"); writes.set(path, "");
      return { async writeFile(data: string) { writes.set(path, data); }, async close() {} };
    },
    async chmod() {},
    async rm(path, options) {
      removes.push({ path, recursive: options.recursive });
      const descendants = [...nodes.keys()].filter((candidate) => candidate.startsWith(`${path}/`));
      if (options.recursive !== true && descendants.length > 0) throw errno("ENOTEMPTY");
      nodes.delete(path); writes.delete(path);
      if (options.recursive === true) for (const candidate of descendants) { nodes.delete(candidate); writes.delete(candidate); }
    },
  };
}

describe("structured SSH host-trust confinement", () => {
  test("writes only an app-private pinned known_hosts file, never an identity", async () => {
    const fs = fakeFileSystem();
    const line = observedLine();
    const bundle = await createStructuredSshHostTrustBundle({ appDataDirectory: "/app-data", target: { host: "build.example.test", port: 22 }, knownHostsLine: line }, { fs, randomHex: () => "a".repeat(32) });
    const directory = "/app-data/structured-ssh-run-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(fs.opens).toEqual([{ path: `${directory}/known_hosts`, flags: "wx", mode: 0o600 }]);
    expect(fs.writes).toEqual(new Map([[`${directory}/known_hosts`, `${line}\n`]]));
    expect(bundle.argv).toContain(`UserKnownHostsFile=${directory}/known_hosts`);
    expect(bundle.argv.join(" ")).not.toContain("IdentityAgent");
    expect(bundle.argv.join(" ")).not.toContain("IdentitiesOnly");
    expect(bundle.argv.join(" ")).not.toContain("-i");
    expect(bundle.argv).toContain("BatchMode=yes");
    expect(bundle.argv).toContain("ClearAllForwardings=yes");
    const redacted = bundle.redactOutput(`ordinary ${directory}/known_hosts ${directory} /app-data`);
    expect(redacted).toContain("ordinary");
    expect(redacted).not.toContain(directory);
    expect(redacted).not.toContain("/app-data");
    await expect(bundle.validateForLaunch()).resolves.toBeUndefined();
    await bundle.cleanup();
    expect(fs.removes).toEqual([{ path: `${directory}/known_hosts`, recursive: undefined }, { path: directory, recursive: undefined }]);
  });

  test("reconstructs the pin and rejects comments, wrong hosts, and malformed data before mutation", async () => {
    for (const line of [`${observedLine()} comment`, `${observedLine()}\n`, `other.example.test ${observedLine().split(" ").slice(1).join(" ")}`, `[build.example.test]:22 ${observedLine().split(" ").slice(1).join(" ")}`]) {
      const fs = fakeFileSystem();
      await expect(createStructuredSshHostTrustBundle({ appDataDirectory: "/app-data", target: { host: "build.example.test", port: 22 }, knownHostsLine: line }, { fs })).rejects.toThrow("input is invalid");
      expect(fs.opens).toEqual([]);
    }
    const ipv6 = await createStructuredSshHostTrustBundle({ appDataDirectory: "/app data", target: { host: "2001:db8::8", port: 2222 }, knownHostsLine: observedLine("2001:db8::8", 2222) }, { fs: fakeFileSystem(), randomHex: () => "b".repeat(32) });
    expect(ipv6.argv).toContain('UserKnownHostsFile="/app data/structured-ssh-run-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/known_hosts"');
  });

  test("fails closed on scratch or known_hosts replacement and never recursively cleans a replacement", async () => {
    const make = (fs: FakeFileSystem, suffix: string) => createStructuredSshHostTrustBundle({ appDataDirectory: "/app-data", target: { host: "build.example.test", port: 22 }, knownHostsLine: observedLine() }, { fs, randomHex: () => suffix.repeat(32) });
    const directoryFs = fakeFileSystem(); const directoryBundle = await make(directoryFs, "c"); directoryFs.replaceRunDirectory();
    await expect(directoryBundle.validateForLaunch()).rejects.toThrow("scratch directory changed before launch"); await directoryBundle.cleanup(); expect(directoryFs.removes).toEqual([]);
    const hostFs = fakeFileSystem(); const hostBundle = await make(hostFs, "d"); hostFs.replaceKnownHostsFile();
    await expect(hostBundle.validateForLaunch()).rejects.toThrow("known-hosts file changed before launch"); await hostBundle.cleanup(); expect(hostFs.removes).toEqual([]);
  });

  test("refuses to recursively delete an injected scratch child", async () => {
    const fs = fakeFileSystem();
    const bundle = await createStructuredSshHostTrustBundle({ appDataDirectory: "/app-data", target: { host: "build.example.test", port: 22 }, knownHostsLine: observedLine() }, { fs, randomHex: () => "e".repeat(32) });
    const directory = "/app-data/structured-ssh-run-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    fs.file(`${directory}/unexpected`);
    await bundle.cleanup();
    expect(fs.removes).toEqual([{ path: `${directory}/known_hosts`, recursive: undefined }, { path: directory, recursive: undefined }]);
  });
});
