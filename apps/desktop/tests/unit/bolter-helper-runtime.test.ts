import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createBolterHelper, verifyBolterHelperSignature } from "../../electron/bolter-bridge/helper-runtime";

test("development helper requires exact executable bytes, architecture receipt and safe paths", async () => {
  const root = await mkdtemp(join(await realpath("/tmp"), "nb-helper-"));
  try {
    await mkdir(join(root, "arm64"));
    const helper = createBolterHelper(root, "arm64")!;
    const bytes = Buffer.alloc(16); bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(0x0100000c, 4);
    await writeFile(helper.executable, bytes, { mode: 0o700 });
    await writeFile(join(root, "arm64", "manifest.json"), JSON.stringify({ protocolVersion: 1, arch: "arm64", bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") }));
    expect(await helper.attest(helper.executable)).toBe(true);
    expect(await helper.attest(join(root, "different"))).toBe(false);
    await chmod(helper.executable, 0o777);
    expect(await helper.attest(helper.executable)).toBe(false);
    await chmod(helper.executable, 0o700);
    await writeFile(helper.executable, "changed helper");
    expect(await helper.attest(helper.executable)).toBe(false);
    expect(createBolterHelper(root, "unsupported")).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("packaged helper requires enclosing app seal and matching developer signatures; ad-hoc and another team fail", async () => {
  const root = await mkdtemp(join(await realpath("/tmp"), "nb-helper-"));
  const app = join(root, "Nautilo.app");
  const resourcesPath = join(app, "Contents", "Resources");
  const executablePath = join(app, "Contents", "MacOS", "Nautilo");
  const binary = join(resourcesPath, "tools-bolter-handover", "arm64", "bolter-handover");
  try {
    await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
    await mkdir(join(resourcesPath, "tools-bolter-handover", "arm64"), { recursive: true });
    await writeFile(executablePath, "synthetic app"); await writeFile(binary, "synthetic helper");
    const calls: (readonly string[])[] = [];
    const run = (args: readonly string[]) => { calls.push(args); return "Identifier=com.nautilo.desktop\nTeamIdentifier=AAAAAAAAAA"; };
    expect(await verifyBolterHelperSignature(binary, "arm64", { resourcesPath, executablePath }, run)).toBe(true);
    expect(calls[0]?.includes("--deep")).toBe(true);
    expect(await verifyBolterHelperSignature(binary, "arm64", { resourcesPath, executablePath }, () => "TeamIdentifier=not set")).toBe(false);
    expect(await verifyBolterHelperSignature(binary, "arm64", { resourcesPath, executablePath }, args =>
      `Identifier=com.nautilo.desktop\nTeamIdentifier=${args.at(-1) === binary ? "BBBBBBBBBB" : "AAAAAAAAAA"}`)).toBe(false);
    expect(await verifyBolterHelperSignature(binary, "x64", { resourcesPath, executablePath }, run)).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
