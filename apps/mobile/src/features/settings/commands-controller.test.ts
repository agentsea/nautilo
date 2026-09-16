/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import type { CommandDetail, CommandsListResponse } from "@nautilo/api-client/browser";

import { commandCatalogueRevision } from "@/features/commands/command-catalogue-events";
import type { SettingsDataScope } from "./settings-data-state";
import {
  commandSettingsErrorMessage,
  createCommandDetailController,
  createCommandsListController,
  mobileCommandKind,
  type CommandsApi,
} from "./commands-controller";

const scopeA: SettingsDataScope = { serverId: "server-a", userId: "user-a", actorId: "actor-a" };
const scopeB: SettingsDataScope = { serverId: "server-b", userId: "user-b", actorId: "actor-b" };
const scopeSameServerOtherViewer: SettingsDataScope = { serverId: "server-a", userId: "user-b", actorId: "actor-b" };
function command(overrides: Partial<CommandDetail> = {}): CommandDetail { return { name: "review", description: "Review this work.", body: "Review: $ARGUMENTS", enabled: true, source: "user", tokenEstimate: 4, updatedAt: "", official: false, forked: false, ...overrides }; }
function list(commands: CommandDetail[] = [command()]): CommandsListResponse { return { commands: commands.map(({ body: _body, ...row }) => row), summary: { total: commands.length, enabled: commands.filter((item) => item.enabled).length, disabled: commands.filter((item) => !item.enabled).length } }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function fakeApi(initial = command()) { let current = initial; const calls: string[] = []; const api: CommandsApi = { async getCommands() { calls.push("list"); return list([current]); }, async getCommand(name) { calls.push(`get:${name}`); return current; }, async putCommand(input) { calls.push(`put:${input.name}`); current = { ...current, ...input }; return current; }, async setCommandEnabled(name, enabled) { calls.push(`toggle:${name}:${enabled}`); current = { ...current, enabled }; return current; }, async customizeCommand(name) { calls.push(`customize:${name}`); current = { ...current, official: true, forked: true, source: "user" }; return current; }, async resetCommand(name) { calls.push(`reset:${name}`); current = command({ name, official: true, forked: false, source: "official" }); }, async deleteCommand(name) { calls.push(`delete:${name}`); } }; return { api, calls }; }

describe("mobile Commands controllers", () => {
  test("maps direct auth and authorization failures to actionable Commands copy", () => {
    expect(commandSettingsErrorMessage(Object.assign(new Error("expired"), { status: 401 }))).toContain("Sign in");
    expect(commandSettingsErrorMessage(Object.assign(new Error("forbidden"), { status: 403 }))).toContain("does not allow");
  });

  test("uses desktop-compatible official affordances and only mutates server rows", async () => {
    expect(mobileCommandKind(command({ official: true, forked: false }))).toBe("official-untouched");
    const source = fakeApi(command({ official: true, forked: false, source: "official" })); const controller = createCommandsListController(() => source.api); controller.setScope(scopeA); await controller.load();
    expect(await controller.setEnabled("review", false)).toEqual({ status: "ignored" }); expect(source.calls).toEqual(["list"]);
  });

  test("creates and toggles through canonical endpoints, invalidating slash discovery", async () => {
    const source = fakeApi(); const controller = createCommandsListController(() => source.api); controller.setScope(scopeA); await controller.load(); const before = commandCatalogueRevision();
    expect((await controller.setEnabled("review", false)).status).toBe("applied"); expect((await controller.create({ name: "rewrite", description: "Rewrite", body: "Rewrite", enabled: true })).status).toBe("applied");
    expect(commandCatalogueRevision()).toBe(before + 2); expect(source.calls).toEqual(["list", "toggle:review:false", "list", "put:rewrite", "list"]);
  });

  test("customizes, resets, and deletes only the currently requested command", async () => {
    const official = fakeApi(command({ official: true, forked: false, source: "official" })); const controller = createCommandDetailController(() => official.api); controller.setScope(scopeA); await controller.load("review");
    expect((await controller.customize()).status).toBe("applied"); expect((await controller.reset()).status).toBe("applied"); expect(official.calls).toEqual(["get:review", "customize:review", "get:review", "reset:review", "get:review"]);
    const yours = fakeApi(); const removeController = createCommandDetailController(() => yours.api); removeController.setScope(scopeA); await removeController.load("review"); expect((await removeController.remove()).status).toBe("applied"); expect(yours.calls).toEqual(["get:review", "delete:review"]);
  });

  test("fences slow detail completion on a server or verified-viewer scope switch", async () => {
    const old = deferred<CommandDetail>(); const source = fakeApi(command({ name: "server-b" })); const controller = createCommandDetailController((scope) => scope.serverId === "server-a" ? { ...source.api, getCommand: () => old.promise } : source.api);
    controller.setScope(scopeA); const stale = controller.load("review"); controller.setScope(scopeB); const fresh = controller.load("server-b"); old.resolve(command({ name: "review", description: "old" }));
    expect(await stale).toEqual({ status: "ignored" }); expect((await fresh).status).toBe("applied"); expect(controller.data.getState().data?.name).toBe("server-b");
  });

  test("does not retain a prior Human's catalogue on the same server", async () => {
    const old = deferred<CommandsListResponse>(); const source = fakeApi(command({ name: "new-viewer-command" }));
    const controller = createCommandsListController((scope) => scope.userId === "user-a" ? { ...source.api, getCommands: () => old.promise } : source.api);
    controller.setScope(scopeA); const stale = controller.load(); controller.setScope(scopeSameServerOtherViewer); const fresh = controller.load(); old.resolve(list([command({ name: "old-viewer-command" })]));
    expect(await stale).toEqual({ status: "ignored" }); expect((await fresh).status).toBe("applied"); expect(controller.data.getState().data?.commands[0]?.name).toBe("new-viewer-command");
  });
});
