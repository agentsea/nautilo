import { expect, test } from "bun:test";
import { mkdtemp, writeFile, realpath, rm, chmod, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MagentOperatorConfig } from "@nautilo/types";
import type { MagentOperatorService } from "../../src/messaging/magent-operator";
import { readMagentBindings, startMagentBindings, validateMagentBindings } from "../../src/messaging/magent-bindings";

const first: MagentOperatorConfig = {
  version: 1, operatorBindingId: "10000000-0000-4000-8000-000000000001",
  sponsorUserId: "10000000-0000-4000-8000-000000000002", genieId: "10000000-0000-4000-8000-000000000003",
  origin: "https://example.com", providerAgentId: "receiving-agent", chatId: "chat-one", senderId: "connector",
  roomName: "External conversation", socketPath: "/path/to/private/one.sock",
  credential: "synthetic-first-binding-capability-with-no-authority-0000", maxRequestBytes: 1024,
};
const second: MagentOperatorConfig = { ...first, operatorBindingId: "20000000-0000-4000-8000-000000000001",
  genieId: "20000000-0000-4000-8000-000000000003", chatId: "chat-two", socketPath: "/path/to/private/two.sock",
  credential: "synthetic-second-binding-capability-with-no-authority-0000" };
const service = {} as MagentOperatorService;
// Bindings listen on Unix sockets at POSIX paths below directories checked for
// POSIX owner and mode, so Windows rejects every binding.
const posixTest = test.skipIf(process.platform === "win32");

posixTest("independent Genies on one instance retain distinct binding configuration", () => {
  expect(() => validateMagentBindings([first, second])).not.toThrow();
  for (const override of [{ operatorBindingId: first.operatorBindingId }, { socketPath: first.socketPath },
    { credential: first.credential }, { chatId: first.chatId, senderId: "other-connector" }]) {
    expect(() => validateMagentBindings([first, { ...second, ...override }])).toThrow("magent_binding_configuration_conflict");
  }
  expect(() => validateMagentBindings([{ ...first, socketPath: "/path/to/private/../private/one.sock" }])).toThrow();
});

posixTest("single config compatibility and complete private manifest validation before activation", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "magent-bindings-")));
  const one = join(directory, "one.json"), two = join(directory, "two.json"), manifest = join(directory, "manifest.json");
  try {
    await writeFile(one, JSON.stringify(first), { mode: 0o600 });
    await writeFile(two, JSON.stringify(second), { mode: 0o600 });
    expect(await readMagentBindings(one)).toEqual([first]);
    await writeFile(manifest, JSON.stringify({ version: 1, configFiles: [one, two] }), { mode: 0o600 });
    expect(await readMagentBindings(manifest)).toEqual([first, second]);
    await chmod(two, 0o644);
    await Promise.resolve(expect(readMagentBindings(manifest)).rejects.toThrow("magent_config_invalid"));
    await chmod(two, 0o600);
    await writeFile(manifest, JSON.stringify({ version: 1, configFiles: [one, one] }));
    await Promise.resolve(expect(readMagentBindings(manifest)).rejects.toThrow("magent_binding_configuration_conflict"));
    await writeFile(manifest, JSON.stringify({ version: 1, configFiles: [] }));
    await Promise.resolve(expect(readMagentBindings(manifest)).rejects.toThrow("magent_config_invalid"));
  } finally { await rm(directory, { recursive: true }); }
});

posixTest("duplicates prevent service construction; partial startup closes already opened sockets", async () => {
  const events: string[] = [];
  const create = async (config: MagentOperatorConfig) => { events.push(`create:${config.chatId}`); return service; };
  const start = (async (config: MagentOperatorConfig) => {
    events.push(`start:${config.chatId}`);
    if (config.chatId === second.chatId) throw new Error("synthetic failure");
    return { close: async () => { events.push(`close:${config.chatId}`); } };
  });
  await Promise.resolve(expect(startMagentBindings([first, first], create, start)).rejects.toThrow());
  expect(events).toEqual([]);
  await Promise.resolve(expect(startMagentBindings([first, second], create, start)).rejects.toThrow("magent_bindings_start_failed"));
  expect(events).toEqual(["create:chat-one", "create:chat-two", "start:chat-one", "start:chat-two", "close:chat-one"]);
});

posixTest("shutdown attempts every socket even when one close fails", async () => {
  const closed: string[] = [];
  const start = (async (config: MagentOperatorConfig) => ({ close: async () => {
    closed.push(config.chatId);
    if (config.chatId === first.chatId) throw new Error("synthetic close failure");
  } }));
  const running = await startMagentBindings([first, second], async () => service, start);
  await Promise.resolve(expect(running.close()).rejects.toThrow("magent_socket_cleanup_failed"));
  expect(closed).toEqual([first.chatId, second.chatId]);
});


posixTest("real Unix sockets are removed after shutdown and partial listen failure", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "magent-sockets-")));
  await chmod(directory, 0o700);
  const one = { ...first, socketPath: join(directory, "one.sock") };
  const two = { ...second, socketPath: join(directory, "two.sock") };
  try {
    const running = await startMagentBindings([one, two], async () => service);
    expect((await lstat(one.socketPath)).isSocket()).toBe(true);
    expect((await lstat(two.socketPath)).mode & 0o777).toBe(0o600);
    await running.close();
    await Promise.resolve(expect(lstat(one.socketPath)).rejects.toThrow());
    await Promise.resolve(expect(lstat(two.socketPath)).rejects.toThrow());
    await writeFile(two.socketPath, "occupied", { mode: 0o600 });
    await Promise.resolve(expect(startMagentBindings([one, two], async () => service)).rejects.toThrow("magent_bindings_start_failed"));
    await Promise.resolve(expect(lstat(one.socketPath)).rejects.toThrow());
    expect((await lstat(two.socketPath)).isFile()).toBe(true);
  } finally { await rm(directory, { recursive: true }); }
});
