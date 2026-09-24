import "../bun-dom-preload";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { EnrollmentReviewStatus } from "@nautilo/types";
import { reapplyHappyDomGlobals } from "../bun-dom-preload";

let status: EnrollmentReviewStatus;
const get = mock(async () => status);
const submit = mock(async (_token: string, message: string): Promise<EnrollmentReviewStatus> => ({ ...status, message, state: "pending", revision: 1 }));
mock.module("../../src/lib/api", () => ({ apiClient: { getEnrollmentReview: get, submitEnrollmentReview: submit } }));
const { EnrollmentReviewGate } = await import("../../src/routes/enrollment-review-gate");
beforeEach(() => {
  reapplyHappyDomGlobals();
  status = { required: true, paused: false, state: "not_requested", message: null, revision: 0 };
  get.mockClear(); submit.mockClear(); get.mockImplementation(async () => status);
});
afterEach(cleanup);
const mount = () => render(<EnrollmentReviewGate token="inv_fixture"><div>Finish profile fixture</div></EnrollmentReviewGate>);

test("requires a nonblank goal, waits for approval, and never displays the PIN/profile prematurely", async () => {
  const view = mount();
  const text = await view.findByLabelText("What do you want to do in this community?");
  expect(view.queryByText("Finish profile fixture")).toBeNull();
  expect(view.getByText("Request to join").hasAttribute("disabled")).toBe(true);
  const { default: userEvent } = await import("@testing-library/user-event");
  const user = userEvent.setup({ document });
  await user.type(text, "   ");
  expect(view.getByText("Request to join").hasAttribute("disabled")).toBe(true);
  await user.clear(text);
  await user.type(text, "I want to build with others.");
  fireEvent.submit(text.closest("form")!);
  await view.findByText(/Awaiting approval/);
  expect(submit).toHaveBeenCalledWith("inv_fixture", "I want to build with others.");
  expect(view.queryByText("Finish profile fixture")).toBeNull();
  status = { ...status, state: "approved", revision: 2, message: "I want to build with others." };
  fireEvent.click(view.getByText("Check status"));
  await view.findByText("Finish profile fixture");
});

test("an approved applicant still waits while joins are paused", async () => {
  status = { ...status, state: "approved", paused: true, message: "Approved goal.", revision: 2 };
  const view = mount();
  await view.findByText(/New joins are paused/);
  expect(view.queryByText("Finish profile fixture")).toBeNull();
});

test("declined applicants cannot resubmit or reach setup", async () => {
  status = { ...status, state: "rejected", message: "Declined goal.", revision: 2 };
  const view = mount(); await view.findByText(/was declined/);
  expect(view.queryByRole("textbox")).toBeNull(); expect(view.queryByText("Finish profile fixture")).toBeNull();
});

test("policy lookup failure stays closed and can be retried", async () => {
  get.mockImplementationOnce(async () => { throw new Error("Offline"); });
  const view = mount(); await view.findByRole("alert");
  expect(view.queryByText("Finish profile fixture")).toBeNull();
  status = { ...status, required: false };
  fireEvent.click(view.getByText("Check status"));
  await waitFor(() => expect(view.queryByText("Finish profile fixture")).not.toBeNull());
});

test("pending requests show the saved message and editing is explicit and cancelable", async () => {
  status = { ...status, state: "pending", message: "I want to build with others.", revision: 1 };
  const view = mount();
  await view.findByText("Request sent");
  expect(view.queryByRole("textbox")).toBeNull();
  expect(view.getByText(status.message!)).toBeTruthy();
  fireEvent.click(view.getByText("Edit message"));
  const input = view.getByRole("textbox") as HTMLTextAreaElement;
  const { default: userEvent } = await import("@testing-library/user-event");
  const user = userEvent.setup({ document });
  await user.clear(input); await user.type(input, "Unsaved change");
  fireEvent.click(view.getByText("Cancel"));
  expect(submit).not.toHaveBeenCalled();
  expect(view.queryByRole("textbox")).toBeNull();
  expect(view.getByText(status.message!)).toBeTruthy();
  fireEvent.click(view.getByText("Edit message"));
  expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe(status.message!);
  await user.clear(view.getByRole("textbox")); await user.type(view.getByRole("textbox"), "A clearer joining goal.");
  fireEvent.submit(view.getByRole("textbox").closest("form")!);
  await view.findByText("A clearer joining goal.", { selector: "p" });
  expect(view.queryByRole("textbox")).toBeNull();
  expect(submit).toHaveBeenCalledWith("inv_fixture", "A clearer joining goal.");
});
