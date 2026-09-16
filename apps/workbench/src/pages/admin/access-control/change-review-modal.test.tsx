import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ApiError } from "@nautilo/api-client/browser";
import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";

const applyChange = mock(async () => ({ applied: true, auditRecorded: true }));
mock.module("../../../lib/api", () => ({ apiClient: { admin: { accessControl: { applyChange } } } }));
const { ChangeReviewModal } = await import("./change-review-modal");

const preview = {
  ok: true,
  operation: { kind: "role.create" as const, slug: "mobile-dev", label: "Mobile dev", capabilities: ["use_terminal"] },
  checks: [{ code: "anti_escalation", passed: true, detail: "held" }],
  failures: [],
  authorityDelta: { added: ["use_terminal"], unchanged: [], removed: [] },
  auditPreview: { kind: "role_created", actorId: "actor" },
  fingerprint: "fresh",
};

afterEach(() => { cleanup(); applyChange.mockReset(); applyChange.mockResolvedValue({ applied: true, auditRecorded: true }); });

describe("ChangeReviewModal", () => {
  test("applies only an accepted preview", async () => {
    reapplyHappyDomGlobals();
    const applied = mock(async () => undefined);
    const view = render(<ChangeReviewModal preview={preview} onClose={() => undefined} onApplied={applied} />);
    fireEvent.click(view.getByRole("button", { name: "Confirm and apply" }));
    await waitFor(() => expect(applyChange).toHaveBeenCalledWith(preview.operation, "fresh"));
  });

  test("ignores Escape while applying, then restores normal dismissal", async () => {
    reapplyHappyDomGlobals();
    let resolveApply!: (value: { applied: boolean; auditRecorded: boolean }) => void;
    applyChange.mockImplementationOnce(() => new Promise((resolve) => { resolveApply = resolve; }));
    const close = mock(() => undefined);
    const view = render(<ChangeReviewModal preview={preview} onClose={close} onApplied={async () => undefined} />);

    fireEvent.click(view.getByRole("button", { name: "Confirm and apply" }));
    await waitFor(() => expect(view.getByRole("status").textContent).toMatch(/Applying/));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(close).not.toHaveBeenCalled();

    resolveApply({ applied: true, auditRecorded: true });
    await waitFor(() => expect(view.queryByRole("status")).toBeNull());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("does not allow a rejected preview to apply", () => {
    reapplyHappyDomGlobals();
    const view = render(<ChangeReviewModal preview={{ ...preview, ok: false, failures: [{ code: "protected", passed: false }] }} onClose={() => undefined} onApplied={async () => undefined} />);
    expect(view.getByRole("button", { name: "Confirm and apply" }).hasAttribute("disabled")).toBe(true);
  });

  test("requires explicit DELETE for destructive changes", async () => {
    reapplyHappyDomGlobals();
    const destructive = { ...preview, operation: { kind: "role.delete" as const, roleId: "role-1" } };
    const view = render(<ChangeReviewModal preview={destructive} onClose={() => undefined} onApplied={async () => undefined} />);
    expect(view.getByRole("button", { name: "Confirm and apply" }).hasAttribute("disabled")).toBe(true);
    fireEvent.input(view.getByLabelText("Type DELETE to confirm"), { target: { value: "DELETE" } });
    await waitFor(() => expect(view.getByRole("button", { name: "Confirm and apply" }).hasAttribute("disabled")).toBe(false));
  });

  test("keeps a stale preview open and requires re-preview", async () => {
    reapplyHappyDomGlobals();
    applyChange.mockRejectedValueOnce(new ApiError(409, "stale_preview"));
    const repreview = mock(() => undefined);
    const view = render(<ChangeReviewModal preview={preview} onClose={() => undefined} onApplied={async () => undefined} onRepreview={repreview} />);
    fireEvent.click(view.getByRole("button", { name: "Confirm and apply" }));
    await waitFor(() => expect(view.getByText(/preview is stale/i)).toBeTruthy());
    expect(view.getByRole("dialog")).toBeTruthy();
    expect(view.getByRole("button", { name: "Confirm and apply" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "Re-preview change" }));
    expect(repreview).toHaveBeenCalledWith(preview.operation);
    view.rerender(<ChangeReviewModal key="replacement" preview={{ ...preview, fingerprint: "replacement" }} onClose={() => undefined} onApplied={async () => undefined} onRepreview={repreview} />);
    expect(view.getByRole("button", { name: "Confirm and apply" }).hasAttribute("disabled")).toBe(false);
  });

  test("returns the audit warning state after a successful apply", async () => {
    reapplyHappyDomGlobals();
    applyChange.mockResolvedValueOnce({ applied: true, auditRecorded: false });
    const applied = mock(async () => undefined);
    const view = render(<ChangeReviewModal preview={preview} onClose={() => undefined} onApplied={applied} />);
    fireEvent.click(view.getByRole("button", { name: "Confirm and apply" }));
    await waitFor(() => expect(applied).toHaveBeenCalledWith(false));
  });

  test("labels atomic shared access and shows each true effective delta", () => {
    reapplyHappyDomGlobals();
    const shared = {
      ...preview,
      operation: {
        kind: "shared_access.create" as const,
        role: { slug: "mobile-dev", label: "Mobile development", capabilities: ["use_terminal"] },
        group: { groupType: "custom:mobile-developers", label: "Mobile developers", ownerUserId: "owner" },
        memberUserIds: ["ada", "ben"],
      },
      affectedUserDeltas: [
        { userId: "ada", added: ["use_terminal"], removed: [], unchanged: ["use_workstation_profiles"] },
        { userId: "ben", added: [], removed: [], unchanged: ["use_terminal"] },
      ],
    };
    const view = render(<ChangeReviewModal preview={shared} onClose={() => undefined} onApplied={async () => undefined} />);
    expect(view.getByText(/Create shared access for/)).toBeTruthy();
    expect(view.getByText(/Human ada's true effective change/)).toBeTruthy();
    expect(view.getAllByText("Unchanged")).toHaveLength(2);
  });
});
