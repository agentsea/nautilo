import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ApiError } from "@nautilo/api-client/browser";
import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";
import type { CapabilitySlug } from "@nautilo/types";

let caps: CapabilitySlug[] = ["manage_members"];
const getCatalogue = mock(async () => ({ capabilities: [], roles: [], groups: [] }));
const getEffectiveAccess = mock(async () => ({
  user: { id: "taylor", handle: "taylor", displayName: "Taylor", server: null }, highestRole: "member",
  capabilities: [{ slug: "use_workstation_profiles", description: "", category: "", granted: true, provenance: [] }],
  groups: [{ id: "group", type: "custom:mobile", label: "Mobile", isSystem: false, ownerId: "owner", roleSlugs: ["mobile"] }],
  roles: [], groupRoleFacts: [{ groupId: "group", groupType: "custom:mobile", groupLabel: "Mobile", groupIsSystem: false, groupOwnerId: "owner", roleSlug: "mobile", roleLabel: "Mobile", roleIsSystem: false, capabilitySlugs: [] }],
}));
const previewChange = mock(async () => ({
  ok: true, operation: { kind: "membership.add" as const, groupId: "group", userId: "taylor" },
  checks: [], failures: [], auditPreview: { kind: "group_member_added", actorId: "actor" }, fingerprint: "fresh",
}));
const applyChange = mock(async () => ({ applied: true, auditRecorded: true }));

mock.module("../../../hooks/use-can", () => ({
  useCan: () => (cap: CapabilitySlug) => caps.includes(cap),
}));
mock.module("../../../lib/api", () => ({
  apiClient: { admin: { users: { list: async () => ({ users: [{ id: "taylor", handle: "taylor", displayName: "Taylor", server: null, groups: [], disabledAt: null }], nextCursor: null }) }, accessControl: { getEffectiveAccess, getCatalogue, previewChange, applyChange } } },
}));

const { AccessControlPage } = await import("./access-control-page");

afterEach(() => { cleanup(); getCatalogue.mockReset(); getCatalogue.mockResolvedValue({ capabilities: [], roles: [], groups: [] }); getEffectiveAccess.mockReset(); getEffectiveAccess.mockResolvedValue({ user: { id: "taylor", handle: "taylor", displayName: "Taylor", server: null }, highestRole: "member", capabilities: [{ slug: "use_workstation_profiles", description: "", category: "", granted: true, provenance: [] }], groups: [{ id: "group", type: "custom:mobile", label: "Mobile", isSystem: false, ownerId: "owner", roleSlugs: ["mobile"] }], roles: [], groupRoleFacts: [{ groupId: "group", groupType: "custom:mobile", groupLabel: "Mobile", groupIsSystem: false, groupOwnerId: "owner", roleSlug: "mobile", roleLabel: "Mobile", roleIsSystem: false, capabilitySlugs: [] }] }); previewChange.mockReset(); previewChange.mockResolvedValue({ ok: true, operation: { kind: "membership.add", groupId: "group", userId: "taylor" }, checks: [], failures: [], auditPreview: { kind: "group_member_added", actorId: "actor" }, fingerprint: "fresh" }); applyChange.mockReset(); applyChange.mockResolvedValue({ applied: true, auditRecorded: true }); });

describe("AccessControlPage", () => {
  test("renders its full workspace tabs for an RBAC manager", () => {
    reapplyHappyDomGlobals();
    caps = ["manage_members"];
    const view = render(<MemoryRouter><AccessControlPage /></MemoryRouter>);
    expect(view.getByTestId("access-control-page")).toBeTruthy();
    expect(view.getByRole("tablist", { name: "Access control sections" })).toBeTruthy();
    expect(view.queryByRole("tab", { name: "Groups" })).toBeNull();
    expect(view.getByRole("tab", { name: "Permissions catalog" })).toBeTruthy();
    expect(view.getByRole("tab", { name: /Audit.*Coming next/ })).toBeTruthy();
  });

  test("denies callers without a management capability", () => {
    reapplyHappyDomGlobals();
    caps = [];
    const view = render(<MemoryRouter><AccessControlPage /></MemoryRouter>);
    expect(view.getByTestId("access-control-denied")).toBeTruthy();
  });

  test("refreshes the shared catalogue and Users view after applying while Users is active", async () => {
    reapplyHappyDomGlobals();
    caps = ["manage_members"];
    const view = render(<MemoryRouter initialEntries={["/admin/access-control/users/taylor"]}><Routes><Route path="/admin/access-control/users/:userId" element={<AccessControlPage />} /></Routes></MemoryRouter>);
    await waitFor(() => expect(view.getByText("Taylor")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(view.getByRole("dialog")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Confirm and apply" }));
    await waitFor(() => expect(getCatalogue).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getEffectiveAccess).toHaveBeenCalledTimes(2));
  });

  test("keeps a later preview when an earlier preview resolves out of order", async () => {
    reapplyHappyDomGlobals();
    let resolveA!: (value: Awaited<ReturnType<typeof previewChange>>) => void;
    let resolveB!: (value: Awaited<ReturnType<typeof previewChange>>) => void;
    getEffectiveAccess.mockResolvedValueOnce({
      user: { id: "taylor", handle: "taylor", displayName: "Taylor", server: null }, highestRole: "member",
      capabilities: [], roles: [],
      groups: [
        { id: "a", type: "custom:a", label: "Group A", isSystem: false, ownerId: "owner", roleSlugs: [] },
        { id: "b", type: "custom:b", label: "Group B", isSystem: false, ownerId: "owner", roleSlugs: [] },
      ],
      groupRoleFacts: [],
    });
    previewChange.mockImplementation((operation) => new Promise((resolve) => {
      if (operation.groupId === "a") resolveA = resolve;
      else resolveB = resolve;
    }));
    const view = render(<MemoryRouter initialEntries={["/admin/access-control/users/taylor"]}><Routes><Route path="/admin/access-control/users/:userId" element={<AccessControlPage />} /></Routes></MemoryRouter>);
    await waitFor(() => expect(view.getByText("Group B")).toBeTruthy());
    const remove = view.getAllByRole("button", { name: "Remove" });
    fireEvent.click(remove[0]!);
    fireEvent.click(remove[1]!);
    resolveB({ ok: true, operation: { kind: "membership.remove", groupId: "b", userId: "taylor" }, checks: [], failures: [], auditPreview: { kind: "preview-b", actorId: "actor" }, fingerprint: "b" });
    await waitFor(() => expect(view.getByText(/preview-b/)).toBeTruthy());
    resolveA({ ok: true, operation: { kind: "membership.remove", groupId: "a", userId: "taylor" }, checks: [], failures: [], auditPreview: { kind: "preview-a", actorId: "actor" }, fingerprint: "a" });
    await waitFor(() => expect(view.queryByText(/preview-a/)).toBeNull());
    expect(view.getByText(/preview-b/)).toBeTruthy();
  });

  test("does not reopen a closed modal when its re-preview resolves", async () => {
    reapplyHappyDomGlobals();
    let resolveInitial!: (value: Awaited<ReturnType<typeof previewChange>>) => void;
    let resolveRepreview!: (value: Awaited<ReturnType<typeof previewChange>>) => void;
    previewChange.mockImplementation(() => new Promise((resolve) => {
      if (!resolveInitial) resolveInitial = resolve;
      else resolveRepreview = resolve;
    }));
    applyChange.mockRejectedValueOnce(new ApiError(409, "stale_preview"));
    const view = render(<MemoryRouter initialEntries={["/admin/access-control/users/taylor"]}><Routes><Route path="/admin/access-control/users/:userId" element={<AccessControlPage />} /></Routes></MemoryRouter>);
    await waitFor(() => expect(view.getByText("Taylor")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Remove" }));
    await act(async () => { resolveInitial({ ok: true, operation: { kind: "membership.remove", groupId: "group", userId: "taylor" }, checks: [], failures: [], auditPreview: { kind: "initial", actorId: "actor" }, fingerprint: "initial" }); });
    await waitFor(() => expect(view.getByRole("dialog")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Confirm and apply" }));
    await waitFor(() => expect(view.getByRole("button", { name: "Re-preview change" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Re-preview change" }));
    await waitFor(() => expect(previewChange).toHaveBeenCalledTimes(2));
    fireEvent.click(view.getByRole("button", { name: "Close review" }));
    expect(view.queryByRole("dialog")).toBeNull();

    await act(async () => { resolveRepreview({ ok: true, operation: { kind: "membership.remove", groupId: "group", userId: "taylor" }, checks: [], failures: [], auditPreview: { kind: "late", actorId: "actor" }, fingerprint: "late" }); });
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  });

  test("ignores a pending preview after the selected user changes", async () => {
    reapplyHappyDomGlobals();
    let resolvePreview!: (value: Awaited<ReturnType<typeof previewChange>>) => void;
    previewChange.mockImplementation(() => new Promise((resolve) => { resolvePreview = resolve; }));
    const view = render(
      <MemoryRouter initialEntries={["/admin/access-control/users/taylor"]}>
        <Routes>
          <Route path="/admin/access-control" element={<AccessControlPage />} />
          <Route path="/admin/access-control/users/:userId" element={<AccessControlPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(view.getByText("Taylor")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(previewChange).toHaveBeenCalledTimes(1));
    fireEvent.click(view.getByRole("tab", { name: "Users" }));
    await waitFor(() => expect(view.getByTestId("access-control-page")).toBeTruthy());

    await act(async () => { resolvePreview({ ok: true, operation: { kind: "membership.remove", groupId: "group", userId: "taylor" }, checks: [], failures: [], auditPreview: { kind: "late", actorId: "actor" }, fingerprint: "late" }); });
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  });
});
