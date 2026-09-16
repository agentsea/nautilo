/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import type { SkillDetail, SkillsListResponse } from "@nautilo/api-client/browser";

import type { SettingsDataScope } from "./settings-data-state";
import {
  canConfigureMobileSkill,
  canDeleteMobileSkill,
  canResetMobileSkill,
  canToggleMobileSkill,
  createSkillDetailController,
  createSkillsListController,
  formatMobileSkillTitle,
  isMobileVisibleSkill,
  MOBILE_MCP_SKILL_MESSAGE,
  mobileSkillKind,
  mobileSkillRequirementsMessage,
  mobileSkillToolOptions,
  mobileSkillsProjection,
  skillSettingsErrorMessage,
  type SkillsApi,
} from "./skills-controller";

const scopeA: SettingsDataScope = { serverId: "server-a", userId: "user-a", actorId: "actor-a" };
const scopeB: SettingsDataScope = { serverId: "server-b", userId: "user-b", actorId: "actor-b" };
const scopeSameServerOtherViewer: SettingsDataScope = { serverId: "server-a", userId: "user-b", actorId: "actor-b" };

function skill(overrides: Partial<SkillDetail> = {}): SkillDetail {
  return {
    name: "writing-guide",
    description: "Keep prose concise.",
    body: "# Writing guide",
    enabled: true,
    source: "user",
    requiresTools: [],
    tokenEstimate: 4,
    updatedAt: "2026-08-09T12:00:00.000Z",
    official: false,
    forked: false,
    ...overrides,
  };
}

function list(skills: SkillDetail[] = [skill()]): SkillsListResponse {
  return {
    skills: skills.map(({ body: _body, ...row }) => row),
    summary: { total: skills.length, enabled: skills.filter((item) => item.enabled).length, disabled: skills.filter((item) => !item.enabled).length },
    catalog: skills.filter((item) => item.enabled).map((item) => ({ name: item.name, description: item.description })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeApi(initial: SkillDetail = skill()) {
  let current = initial;
  const calls: string[] = [];
  const api: SkillsApi = {
    async listSkills() { calls.push("list"); return list([current]); },
    async getSkill(name) { calls.push(`get:${name}`); return current; },
    async setSkillEnabled(name, enabled) { calls.push(`toggle:${name}:${enabled}`); current = { ...current, enabled }; return current; },
    async customizeSkill(name) { calls.push(`customize:${name}`); current = { ...current, official: true, forked: true, source: "user" }; return current; },
    async saveSkill(input) { calls.push(`save:${input.name}`); current = { ...current, ...input }; return current; },
    async resetSkill(name) { calls.push(`reset:${name}`); current = { ...current, official: true, forked: false, source: "official", enabled: true }; return { ok: true }; },
    async deleteSkill(name) { calls.push(`delete:${name}`); return { ok: true }; },
  };
  return { api, calls, get current() { return current; } };
}

describe("mobile Skills presentation", () => {
  test("uses the same official/customized distinction as desktop affordances", () => {
    expect(mobileSkillKind(skill())).toBe("yours");
    expect(mobileSkillKind(skill({ official: true, forked: false }))).toBe("official-untouched");
    expect(mobileSkillKind(skill({ official: true, forked: true }))).toBe("official-customized");
    expect(canToggleMobileSkill(skill({ official: true, forked: false }))).toBe(false);
    expect(canConfigureMobileSkill(skill({ official: true, forked: false }))).toBe(false);
    expect(canResetMobileSkill(skill({ official: true, forked: true }))).toBe(true);
    expect(canResetMobileSkill(skill())).toBe(false);
    expect(canDeleteMobileSkill(skill())).toBe(true);
    expect(canDeleteMobileSkill(skill({ official: true, forked: true }))).toBe(false);
    expect(formatMobileSkillTitle("interactive_artifact-authoring")).toBe("Interactive Artifact Authoring");
  });

  test("keeps auth and authorization failures actionable", () => {
    expect(skillSettingsErrorMessage(Object.assign(new Error("expired"), { status: 401 }))).toContain("Sign in");
    expect(skillSettingsErrorMessage(Object.assign(new Error("forbidden"), { status: 403 }))).toContain("does not allow");
  });

  test("omits local-MCP Skills from the mobile projection without changing other Skills", () => {
    const visible = skill({ name: "writing-guide", enabled: true });
    const mcpOnly = skill({ name: "mcp-setup", requiresTools: ["manage_local_mcp"], enabled: true });
    const projection = mobileSkillsProjection(list([visible, mcpOnly]));

    expect(isMobileVisibleSkill(visible)).toBe(true);
    expect(isMobileVisibleSkill(mcpOnly)).toBe(false);
    expect(projection.skills.map((item) => item.name)).toEqual(["writing-guide"]);
    expect(projection.summary).toEqual({ total: 1, enabled: 1, disabled: 0 });
    expect(mobileSkillRequirementsMessage({ requiresTools: ["manage_local_mcp"] })).toBe(MOBILE_MCP_SKILL_MESSAGE);
    expect(mobileSkillRequirementsMessage({ requiresTools: ["run_shell"] })).toBeNull();
  });

  test("offers friendly server capabilities while withholding desktop-only MCP setup", () => {
    expect(mobileSkillToolOptions([
      { name: "run_web_search", label: "Web search", description: "Search the web.", category: "search" },
      { name: "manage_local_mcp", label: "Local MCP setup", description: "Configure MCP.", category: "admin" },
    ])).toEqual([
      { name: "run_web_search", label: "Web search", description: "Search the web.", category: "search" },
    ]);
  });
});

describe("mobile Skills controllers", () => {
  test("toggles only a canonical mutable row, then refreshes the server catalogue", async () => {
    const source = fakeApi();
    const controller = createSkillsListController(() => source.api);
    controller.setScope(scopeA);
    await controller.load();

    expect(await controller.setEnabled("writing-guide", false)).toMatchObject({ status: "applied" });
    expect(source.calls).toEqual(["list", "toggle:writing-guide:false", "list"]);
    expect(controller.data.getState().data?.skills[0]?.enabled).toBe(false);
  });

  test("never PATCHes an untouched official Skill or a foreign list name", async () => {
    const source = fakeApi(skill({ official: true, forked: false, source: "official" }));
    const controller = createSkillsListController(() => source.api);
    controller.setScope(scopeA);
    await controller.load();

    expect(await controller.setEnabled("writing-guide", false)).toEqual({ status: "ignored" });
    expect(await controller.setEnabled("not-in-catalog", false)).toEqual({ status: "ignored" });
    expect(source.calls).toEqual(["list"]);
  });

  test("customizes the official server copy before it can be configured and re-reads detail", async () => {
    const source = fakeApi(skill({ official: true, forked: false, source: "official" }));
    const controller = createSkillDetailController(() => source.api);
    controller.setScope(scopeA);
    await controller.load("writing-guide");
    expect(await controller.customize()).toMatchObject({ status: "applied" });
    expect(source.calls).toEqual(["get:writing-guide", "customize:writing-guide", "get:writing-guide"]);

    expect(await controller.save({ ...source.current, description: "My concise writing guide" })).toMatchObject({ status: "applied" });
    expect(source.calls).toEqual([
      "get:writing-guide", "customize:writing-guide", "get:writing-guide", "save:writing-guide", "get:writing-guide",
    ]);
  });

  test("does not let a detail view save a different Skill identity", async () => {
    const source = fakeApi();
    const controller = createSkillDetailController(() => source.api);
    controller.setScope(scopeA);
    await controller.load("writing-guide");
    expect(await controller.save({ ...skill(), name: "other-skill" })).toEqual({ status: "ignored" });
    expect(source.calls).toEqual(["get:writing-guide"]);
  });

  test("creates a new server Skill then re-reads its canonical detail", async () => {
    const source = fakeApi();
    const controller = createSkillDetailController(() => source.api);
    controller.setScope(scopeA);
    expect(await controller.create({
      name: "  meeting-notes  ", description: "Capture decisions.", body: "# Notes", enabled: true, requiresTools: [],
    })).toMatchObject({ status: "applied" });
    expect(source.calls).toEqual(["save:meeting-notes", "get:meeting-notes"]);
    expect(controller.data.getState().data).toMatchObject({ name: "meeting-notes" });
  });

  test("never creates, saves, or mutates a local-MCP Skill from mobile", async () => {
    const source = fakeApi(skill({ requiresTools: ["manage_local_mcp"] }));
    const listController = createSkillsListController(() => source.api);
    listController.setScope(scopeA);
    await listController.load();
    expect(await listController.setEnabled("writing-guide", false)).toEqual({ status: "ignored" });

    const detailController = createSkillDetailController(() => source.api);
    detailController.setScope(scopeA);
    await detailController.load("writing-guide");
    expect(await detailController.customize()).toEqual({ status: "ignored" });
    expect(await detailController.save({ ...source.current, description: "Nope" })).toEqual({ status: "ignored" });
    expect(await detailController.create({
      name: "mcp-copy", description: "Nope", body: "# Nope", enabled: true, requiresTools: ["manage_local_mcp"],
    })).toEqual({ status: "ignored" });
    expect(source.calls).toEqual(["list", "get:writing-guide"]);
  });

  test("resets only a customized official copy and reloads the official detail", async () => {
    const source = fakeApi(skill({ official: true, forked: true, source: "user", enabled: false }));
    const controller = createSkillDetailController(() => source.api);
    controller.setScope(scopeA);
    await controller.load("writing-guide");
    expect(await controller.reset()).toMatchObject({ status: "applied" });
    expect(source.calls).toEqual(["get:writing-guide", "reset:writing-guide", "get:writing-guide"]);
    expect(controller.data.getState().data).toMatchObject({ official: true, forked: false, enabled: true });
  });

  test("deletes only the exact custom server Skill and clears retained detail", async () => {
    const source = fakeApi();
    const controller = createSkillDetailController(() => source.api);
    controller.setScope(scopeA);
    await controller.load("writing-guide");
    expect(await controller.delete()).toEqual({ status: "applied" });
    expect(source.calls).toEqual(["get:writing-guide", "delete:writing-guide"]);
    expect(controller.data.getState()).toMatchObject({ data: null, mutating: false });
  });

  test("keeps official originals and stale route details from emitting reset or delete", async () => {
    const source = fakeApi(skill({ official: true, forked: false, source: "official" }));
    const controller = createSkillDetailController(() => source.api);
    controller.setScope(scopeA);
    await controller.load("writing-guide");
    expect(await controller.reset()).toEqual({ status: "ignored" });
    expect(await controller.delete()).toEqual({ status: "ignored" });
    expect(source.calls).toEqual(["get:writing-guide"]);
  });

  test("does not save retained detail while navigation is loading another Skill", async () => {
    const next = deferred<SkillDetail>();
    const source = fakeApi();
    source.api.getSkill = (name) => name === "second-skill" ? next.promise : Promise.resolve(source.current);
    const controller = createSkillDetailController(() => source.api);
    controller.setScope(scopeA);
    await controller.load("writing-guide");
    const loadingSecond = controller.load("second-skill");

    expect(await controller.save({ ...skill(), description: "stale draft" })).toEqual({ status: "ignored" });
    next.resolve(skill({ name: "second-skill" }));
    expect((await loadingSecond).status).toBe("applied");
    expect(source.calls).toEqual([]);
  });

  test("recovers a customization race by re-reading the server-owned copy", async () => {
    const source = fakeApi(skill({ official: true, forked: false, source: "official" }));
    source.api.customizeSkill = async (name) => {
      source.calls.push(`customize:${name}`);
      // Model another trusted client winning the server's create race.
      throw Object.assign(new Error("already customized"), { status: 409 });
    };
    let gets = 0;
    source.api.getSkill = async (name) => {
      source.calls.push(`get:${name}`);
      gets += 1;
      return skill({ official: true, forked: gets > 1, source: gets > 1 ? "user" : "official" });
    };
    const controller = createSkillDetailController(() => source.api);
    controller.setScope(scopeA);
    await controller.load("writing-guide");

    expect(await controller.customize()).toMatchObject({ status: "applied" });
    expect(controller.data.getState().data).toMatchObject({ official: true, forked: true });
    expect(source.calls).toEqual(["get:writing-guide", "customize:writing-guide", "get:writing-guide"]);
  });

  test("erases a pending catalogue response when the verified auth scope disappears", async () => {
    const pending = deferred<SkillsListResponse>();
    const source = fakeApi();
    source.api.listSkills = () => pending.promise;
    const controller = createSkillsListController(() => source.api);
    controller.setScope(scopeA);
    const loading = controller.load();

    controller.setScope(null);
    pending.resolve(list([skill({ name: "old-session-skill" })]));

    expect(await loading).toEqual({ status: "ignored" });
    expect(controller.data.getState()).toMatchObject({ scope: null, data: null });
  });

  test("drops slow list and detail completions after an auth identity or server switch", async () => {
    const oldList = deferred<SkillsListResponse>();
    const oldDetail = deferred<SkillDetail>();
    const current = fakeApi(skill({ name: "server-b-skill" }));
    const api: SkillsApi = {
      ...current.api,
      listSkills: () => oldList.promise,
      getSkill: (name) => name === "writing-guide" ? oldDetail.promise : current.api.getSkill(name),
    };
    const listController = createSkillsListController((scope) => scope.serverId === "server-a" ? api : current.api);
    const detailController = createSkillDetailController((scope) => scope.serverId === "server-a" ? api : current.api);
    listController.setScope(scopeA);
    detailController.setScope(scopeA);
    const staleList = listController.load();
    const staleDetail = detailController.load("writing-guide");

    listController.setScope(scopeB);
    detailController.setScope(scopeB);
    const freshList = listController.load();
    const freshDetail = detailController.load("server-b-skill");
    oldList.resolve(list([skill({ name: "stale-a" })]));
    oldDetail.resolve(skill({ name: "writing-guide", description: "stale" }));

    expect(await staleList).toEqual({ status: "ignored" });
    expect(await staleDetail).toEqual({ status: "ignored" });
    expect((await freshList).status).toBe("applied");
    expect((await freshDetail).status).toBe("applied");
    expect(listController.data.getState().data?.skills[0]?.name).toBe("server-b-skill");
    expect(detailController.data.getState().data?.name).toBe("server-b-skill");
  });

  test("does not retain a prior Human's Skill catalogue on the same server", async () => {
    const old = deferred<SkillsListResponse>();
    const source = fakeApi(skill({ name: "new-viewer-skill" }));
    const controller = createSkillsListController((scope) => scope.userId === "user-a"
      ? { ...source.api, listSkills: () => old.promise }
      : source.api);

    controller.setScope(scopeA);
    const stale = controller.load();
    controller.setScope(scopeSameServerOtherViewer);
    const fresh = controller.load();
    old.resolve(list([skill({ name: "old-viewer-skill" })]));

    expect(await stale).toEqual({ status: "ignored" });
    expect((await fresh).status).toBe("applied");
    expect(controller.data.getState().data?.skills[0]?.name).toBe("new-viewer-skill");
  });
});
