import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ComponentProps } from "react";
import type { AgentAccessStatus } from "../../../desktop/electron/ready-to-work-contract";
import type { DesktopReadyToWorkAPI, DesktopUncontainedHostCommandsAPI, DesktopWorkstationProfilesAPI } from "../../src/lib/desktop";
import { AgentAccessControl } from "../../src/components/agent-access-control";
import { WorkbenchPortalProvider } from "../../src/components/workbench-portals";
import { ReadyToWorkSegment } from "../../src/components/footer/ready-to-work-segment";

const reviewed = {
  seed: { id: "development", revision: 3, name: "Development tools", protectedPolicyVersion: 1, networkMode: "host" as const,
    discoveryProviders: [], environmentKeys: ["PATH"], capabilities: [{ id: "developer_tools", backend: "local_process" as const }], userEnvironment: true },
  review: { generatedAt: "2026-01-01T00:00:00.000Z", platform: "darwin", home: "/path/to", networkMode: "host" as const, rows: [], hostNetworkImplication: "Host network", hardBoundaries: [], summary: { found: 0, optional: 0, missing: 0 } },
  scope: { currentProject: "/path/to/project", roots: [{ path: "/path/to/tools", access: ["read", "create_modify"] }], network: { mode: "host" as const, allow: [] }, environmentKeys: ["PATH"] },
};
const profiles: Pick<DesktopWorkstationProfilesAPI, "materializeSeedProfile" | "prepareActivation"> = {
  materializeSeedProfile: async () => ({ ok: true, data: { created: false, revision: 1, profile: { ...reviewed.seed, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" } } }),
  prepareActivation: async () => ({ ok: true, data: reviewed }),
};
function AccessControl(props: ComponentProps<typeof AgentAccessControl>) { return <AgentAccessControl workstationProfiles={profiles} {...props} />; }

const basic: AgentAccessStatus = { sandboxedChoice: "basic", choiceReason: "default", readiness: "ready", reason: null, repairAction: null,
  fullMac: { state: "inactive", eligible: true }, capabilities: { commands: true, interactiveContainedTerminals: true, fullMacOneShot: false } };
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve }; }
function fixture(initial: AgentAccessStatus = basic) {
  let status = initial;
  const listeners = new Set<() => void>();
  const choices: unknown[] = [];
  let reads = 0, restores = 0, legacy = 0;
  let get = async () => status;
  let choose = async (input: { choice: "basic" | "development"; pin?: string }) => ({ ...basic, sandboxedChoice: input.choice });
  const api: DesktopReadyToWorkAPI = {
    getAgentAccess: async () => { reads++; return get(); },
    chooseAgentAccess: async input => { choices.push(input); status = await choose(input); return status; },
    restoreDevelopment: async () => { restores++; return { ...initial, sandboxedChoice: "development", readiness: "ready", reason: null, repairAction: null }; },
    onAgentAccessChanged: handler => { listeners.add(handler); return () => { listeners.delete(handler); }; },
    get: async () => ({ mode: "standard", components: [] }), enroll: async () => { legacy++; return { mode: "ready", components: [] }; },
    disable: async () => { legacy++; return { mode: "standard", components: [] }; }, restore: async () => { legacy++; return { mode: "ready", components: [] }; },
    onStatusChanged: () => () => {}, onRestoreRendererOwners: () => () => {}, acknowledgeRendererOwners: async () => {},
    reportRendererOwners: async () => ({ mode: "standard", components: [] }),
  };
  return { api, choices, reads: () => reads, restores: () => restores, legacy: () => legacy, listeners,
    emit: () => { listeners.forEach(handler => handler()); }, status: (next: AgentAccessStatus) => { status = next; },
    get: (next: typeof get) => { get = next; }, choose: (next: typeof choose) => { choose = next; } };
}
async function verifyPin(view: ReturnType<typeof render>) {
  await view.findByRole("heading", { name: /Choose Development|Enable temporary Full Mac/ });
  const user = userEvent.setup();
  await user.click(view.baseElement.querySelector('input[type="password"]')!);
  await user.keyboard("123456");
  await view.findByText("Press Enter to verify");
  await user.click(view.getByRole("button", { name: "Verify" }));
}
beforeEach(reapplyHappyDomGlobals);
afterEach(cleanup);

test("choice remains separate from failed readiness, with its exact repair condition", async () => {
  const f = fixture({ ...basic, readiness: "needs_attention", reason: "authentication_unavailable", repairAction: "open_settings", capabilities: { ...basic.capabilities, commands: false } });
  const view = render(<AccessControl readyToWork={f.api} />);
  await view.findByText("Sign in to check Agent access.");
  expect(view.getByRole("radio", { name: "Basic" }).getAttribute("aria-checked")).toBe("true");
  expect(view.queryByText("Commands ready.")).toBeNull();
  expect(view.getByRole("link", { name: "Open settings" }).getAttribute("href")).toBe("/settings#startup");
  expect(view.queryByText("Review Development")).toBeNull();
});
test("Development requires PIN, duplicate submit is fenced, and selected Development does not ask again", async () => {
  const f = fixture(); const pending = deferred<AgentAccessStatus>(); f.choose(() => pending.promise);
  const view = render(<AccessControl readyToWork={f.api} />); await view.findByText("Commands ready.");
  fireEvent.click(view.getByRole("radio", { name: "Development" })); expect(f.choices).toEqual([]);
  await verifyPin(view); fireEvent.click(await view.findByRole("button", { name: "Checking access…" }));
  expect(f.choices).toEqual([{ choice: "development", pin: "123456", profileId: "development", profileRevision: 3 }]);
  await act(async () => { pending.resolve({ ...basic, sandboxedChoice: "development" }); });
  expect(view.queryByRole("heading", { name: "Choose Development" })).toBeNull();
  fireEvent.click(view.getByRole("radio", { name: "Development" }));
  expect(view.queryByRole("heading", { name: "Choose Development" })).toBeNull(); expect(f.choices).toHaveLength(1);
  fireEvent.click(view.getByRole("radio", { name: "Basic" }));
  await waitFor(() => expect(f.choices[1]).toEqual({ choice: "basic" })); expect(f.legacy()).toBe(0);
});
test("content-free invalidations coalesce reads and a stale initial response cannot replace the current choice", async () => {
  const f = fixture(); const initial = deferred<AgentAccessStatus>(); f.get(() => initial.promise);
  const view = render(<AccessControl readyToWork={f.api} />); await waitFor(() => expect(f.reads()).toBe(1));
  const current = { ...basic, sandboxedChoice: "development" as const };
  f.get(async () => current);
  await act(async () => { for (let i = 0; i < 20; i++) f.emit(); });
  expect(f.reads()).toBe(1);
  await act(async () => { initial.resolve(basic); });
  await waitFor(() => expect(view.getByRole("radio", { name: "Development" }).getAttribute("aria-checked")).toBe("true"));
  expect(f.reads()).toBe(2); view.unmount(); expect(f.listeners.size).toBe(0);
});
test("authenticated notifications during a successful choice win over its response without leaving PIN open", async () => {
  const f = fixture(); f.choose(async input => { f.status({ ...basic, sandboxedChoice: input.choice, readiness: "reconnecting" }); f.emit(); return { ...basic, sandboxedChoice: input.choice }; });
  const view = render(<AccessControl readyToWork={f.api} />); await view.findByText("Commands ready.");
  fireEvent.click(view.getByRole("radio", { name: "Development" })); await verifyPin(view);
  await view.findByText("Reconnecting to this Desktop…");
  expect(view.queryByRole("heading", { name: "Choose Development" })).toBeNull();
});
test("auth change closes PIN and late old choice cannot replace fresh current status", async () => {
  const f = fixture(); const pending = deferred<AgentAccessStatus>(); f.choose(() => pending.promise);
  const view = render(<AccessControl readyToWork={f.api} />); await view.findByText("Commands ready.");
  fireEvent.click(view.getByRole("radio", { name: "Development" })); await verifyPin(view);
  await waitFor(() => expect(f.choices).toHaveLength(1));
  await act(async () => { window.dispatchEvent(new Event("nautilo:auth-changed")); });
  await act(async () => { pending.resolve({ ...basic, sandboxedChoice: "development" }); });
  expect(view.getByRole("radio", { name: "Basic" }).getAttribute("aria-checked")).toBe("true");
  expect(view.queryByRole("heading", { name: "Choose Development" })).toBeNull();
});
test("restore is a narrow repair and Full Mac remains an explicit separate temporary owner", async () => {
  const f = fixture({ ...basic, sandboxedChoice: "development", readiness: "needs_attention", reason: "development_not_active", repairAction: "restore_development",
    fullMac: { state: "active", eligible: true } });
  let reductions = 0, activations = 0;
  const fullMac: DesktopUncontainedHostCommandsAPI = { getStatus: async () => { throw new Error("Must use canonical Agent status"); },
    activate: async () => { activations++; return { ok: true }; }, disable: async () => { reductions++; return { ok: true }; } };
  const view = render(<AccessControl readyToWork={f.api} fullMac={fullMac} />);
  fireEvent.click(await view.findByRole("button", { name: "Restore Development" })); await waitFor(() => expect(f.restores()).toBe(1));
  expect(f.legacy()).toBe(0); expect(view.getByText(/Agent-created Full Mac terminals are not supported/)).toBeTruthy();
  expect(view.getByText("Managed command access is unavailable in this mode.")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Turn off Full Mac access" })); await waitFor(() => expect(reductions).toBe(1));
  expect(activations).toBe(0); expect(view.queryByText("Command access is ready.")).toBeNull();
});
test("the primary footer uses Agent access on a supported bridge instead of a competing legacy switch", async () => {
  const f = fixture(); const view = render(<ReadyToWorkSegment isDesktopShell readyToWork={f.api} standardSegment={<span>Legacy switch</span>} />);
  await view.findByText("Agent access: Basic"); expect(view.queryByText("Legacy switch")).toBeNull();
  expect(view.queryByText("Ready: Set up")).toBeNull();
});

test("a rejected status read remains unavailable and cannot imply inactive Full Mac", async () => {
  const f = fixture(); f.get(async () => { throw new Error("unavailable"); });
  const fullMac: DesktopUncontainedHostCommandsAPI = { getStatus: async () => { throw new Error("unused"); }, activate: async () => ({ ok: true }), disable: async () => ({ ok: true }) };
  const view = render(<AccessControl readyToWork={f.api} fullMac={fullMac} compact />);
  fireEvent.click(await view.findByRole("button", { name: "Agent access: Unavailable" }));
  expect(await view.findByText("Current access is unavailable.")).toBeTruthy();
  expect(view.getByText("Temporary Full Mac access · Status unconfirmed")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Enable temporarily with PIN" })).toBeNull();
  expect((view.getByRole("button", { name: "Turn off Full Mac access" }) as HTMLButtonElement).disabled).toBe(false);
  expect(view.queryByText(/Temporary Full Mac access · Inactive/)).toBeNull();
});
test("an unreadable saved choice is explained once", async () => {
  const f = fixture({ ...basic, sandboxedChoice: null, choiceReason: "saved_state_unavailable", readiness: "needs_attention", reason: "saved_state_unavailable", repairAction: "retry" });
  const view = render(<AccessControl readyToWork={f.api} />);
  await view.findByText("Your saved access choice could not be read.");
  expect(view.queryByText("Your saved choice could not be read.")).toBeNull();
});

test("compact access controls escape clipped footer containers and close cleanly", async () => {
  const f = fixture(); const view = render(<div style={{ overflow: "hidden" }}><AccessControl readyToWork={f.api} compact /></div>);
  const trigger = await view.findByRole("button", { name: "Agent access: Basic" });
  fireEvent.click(trigger);
  const dialog = await view.findByRole("dialog", { name: "Agent access on this Mac" });
  expect(view.container.contains(dialog)).toBe(false);
  expect(dialog.classList.contains("fixed")).toBe(true);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(view.queryByRole("dialog", { name: "Agent access on this Mac" })).toBeNull();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  view.unmount(); expect(f.listeners.size).toBe(0);
});

test("an invalidation during a rejected choice keeps the current PIN failure visible", async () => {
  const f = fixture(); f.choose(async () => { f.emit(); throw new Error("Rejected"); });
  const view = render(<AccessControl readyToWork={f.api} />); await view.findByText("Commands ready.");
  fireEvent.click(view.getByRole("radio", { name: "Development" })); await verifyPin(view);
  await waitFor(() => expect(view.getAllByText("Agent access could not be changed. Check its current status and try again.").length).toBeGreaterThan(0));
  expect(view.getByRole("heading", { name: "Choose Development" })).toBeTruthy();
  expect(f.choices).toHaveLength(1);
});

test("known incorrect PIN errors remain visible through refresh without echoing arbitrary IPC details", async () => {
  const f = fixture(); f.choose(async () => { f.emit(); throw new Error("Error invoking remote method: That PIN is incorrect."); });
  const view = render(<AccessControl readyToWork={f.api} />); await view.findByText("Commands ready.");
  fireEvent.click(view.getByRole("radio", { name: "Development" })); await verifyPin(view);
  await waitFor(() => expect(view.getAllByText("That PIN is incorrect.").length).toBeGreaterThan(0));
  await act(async () => { f.emit(); });
  expect(view.getAllByText("That PIN is incorrect.").length).toBeGreaterThan(0);
  expect(view.queryByText(/Error invoking remote method/)).toBeNull();
});

test("Full Mac changes invalidate every mounted access view through the existing owner event", async () => {
  const f = fixture(); const view = render(<AccessControl readyToWork={f.api} />); await view.findByText("Commands ready.");
  f.status({ ...basic, fullMac: { state: "active", eligible: true } });
  await act(async () => { window.dispatchEvent(new Event("nautilo:uncontained-host-commands-changed")); });
  await view.findByText("Temporary Full Mac access · Active for this app session");
  expect(f.reads()).toBe(2);
});
test("profile repair reviews actual scope and submits exact selectors with one PIN", async () => {
  const f = fixture({ ...basic, sandboxedChoice: "development", readiness: "needs_attention", reason: "workstation_profile_update_needed", repairAction: "review_development" });
  const view = render(<AccessControl readyToWork={f.api} />);
  fireEvent.click(await view.findByRole("button", { name: "Review Development with PIN" }));
  await view.findByRole("heading", { name: "Choose Development" });
  expect(view.getByText("Development tools · revision 3")).toBeTruthy();
  expect(view.getByText(/Current Folder: \/path\/to\/project/)).toBeTruthy();
  expect(view.getByText("/path/to/tools · read, create and modify files")).toBeTruthy();
  expect(view.getByText("Network: Destinations available to this Mac, including the internet.")).toBeTruthy();
  expect(view.getByText(/Commands and package scripts can read and use credentials in your home folder/)).toBeTruthy();
  expect(f.choices).toHaveLength(0); await verifyPin(view);
  expect(f.choices).toEqual([{ choice: "development", pin: "123456", profileId: "development", profileRevision: 3 }]);
});

test("legacy and custom profiles without user-environment authority make no native credential promise", async () => {
  const f = fixture();
  const legacy = { ...profiles, prepareActivation: async () => ({ ok: true as const,
    data: { ...reviewed, seed: { ...reviewed.seed, userEnvironment: undefined } } }) };
  const view = render(<AccessControl readyToWork={f.api} workstationProfiles={legacy} />);
  await view.findByText("Commands ready."); fireEvent.click(view.getByRole("radio", { name: "Development" }));
  await view.findByRole("heading", { name: "Choose Development" });
  expect(view.queryByText(/Commands and package scripts can read and use credentials in your home folder/)).toBeNull();
});

test("a profile changed between materialization and review cannot reach PIN or activation", async () => {
  const f = fixture(); const changed = { ...profiles, prepareActivation: async () => ({ ok: true as const, data: { ...reviewed, seed: { ...reviewed.seed, revision: 4 } } }) };
  const view = render(<AccessControl readyToWork={f.api} workstationProfiles={changed} />);
  await view.findByText("Commands ready."); fireEvent.click(view.getByRole("radio", { name: "Development" }));
  await view.findByText("Development scope could not be reviewed. Check the profile and try again.");
  expect(view.queryByRole("heading", { name: "Choose Development" })).toBeNull(); expect(f.choices).toHaveLength(0);
});
test("auth retirement during profile review drops its late scope and PIN prompt", async () => {
  const f = fixture(); const pending = deferred<Awaited<ReturnType<DesktopWorkstationProfilesAPI["prepareActivation"]>>>();
  let reads = 0;
  const delayed = { ...profiles, prepareActivation: () => { reads++; return pending.promise; } };
  const view = render(<AccessControl readyToWork={f.api} workstationProfiles={delayed} />); await view.findByText("Commands ready.");
  fireEvent.click(view.getByRole("radio", { name: "Development" })); await waitFor(() => expect(reads).toBe(1));
  await act(async () => { window.dispatchEvent(new Event("nautilo:auth-changed")); pending.resolve({ ok: true, data: reviewed }); });
  expect(view.queryByText("Development tools · revision 3")).toBeNull();
  expect(view.queryByRole("heading", { name: "Choose Development" })).toBeNull(); expect(f.choices).toHaveLength(0);
});

test("opening the compact control checks current Full Mac status before repeating an old confirmation", async () => {
  const f = fixture({ ...basic, fullMac: { state: "active", eligible: true } });
  const view = render(<AccessControl readyToWork={f.api} compact />);
  const trigger = await view.findByRole("button", { name: "Agent access: Basic" });
  const pending = deferred<AgentAccessStatus>(); f.get(() => pending.promise);
  fireEvent.click(trigger);
  await view.findByText("Temporary Full Mac access · Checking…");
  expect(view.queryByText("Temporary Full Mac access · Active for this app session")).toBeNull();
  await act(async () => { pending.resolve({ ...basic, fullMac: { state: "unconfirmed", eligible: false } }); });
  await view.findByText("Temporary Full Mac access · Status unconfirmed");
});
test("visibility regain requests a fresh status without a polling timer", async () => {
  const f = fixture(); const view = render(<AccessControl readyToWork={f.api} />); await view.findByText("Commands ready.");
  const original = Object.getOwnPropertyDescriptor(document, "visibilityState");
  try {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    f.status({ ...basic, readiness: "reconnecting" });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await view.findByText("Reconnecting to this Desktop…"); expect(f.reads()).toBe(2);
  } finally { if (original) Object.defineProperty(document, "visibilityState", original); else Reflect.deleteProperty(document, "visibilityState"); }
});

test("the scope-bearing PIN modal escapes the clipped footer inside its Workbench admission boundary", async () => {
  const f = fixture();
  const view = render(<section data-testid="admitted-workspace"><WorkbenchPortalProvider>
    <div data-testid="clipped-footer" style={{ overflow: "hidden" }}><AccessControl readyToWork={f.api} compact /></div>
  </WorkbenchPortalProvider></section>);
  fireEvent.click(await view.findByRole("button", { name: "Agent access: Basic" }));
  fireEvent.click(await view.findByRole("radio", { name: "Development" }));
  await view.findByRole("heading", { name: "Choose Development" });
  const inputs = view.baseElement.querySelectorAll<HTMLInputElement>('input[type="password"]');
  expect(inputs).toHaveLength(1);
  const input = inputs[0];
  expect(view.getByTestId("clipped-footer").contains(input)).toBe(false);
  expect(view.getByTestId("admitted-workspace").querySelector("[data-workbench-portals]")?.contains(input)).toBe(true);
  expect(input.disabled).toBe(false); expect(document.activeElement).toBe(input);
  expect(view.getByText("Development tools · revision 3")).toBeTruthy();
  expect(view.getByText("/path/to/tools · read, create and modify files")).toBeTruthy();
  await verifyPin(view);
  expect(f.choices).toEqual([{ choice: "development", pin: "123456", profileId: "development", profileRevision: 3 }]);
  await waitFor(() => expect(view.baseElement.querySelector('input[type="password"]')).toBeNull());
  view.unmount(); expect(f.listeners.size).toBe(0);
});
