import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  ProviderCredentialApiError,
  type CredentialMetadata,
} from "@nautilo/api-client/browser";
import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";
import {
  PERSONAL_PROVIDER_CREDENTIALS_CHANGED_EVENT,
  PERSONAL_PROVIDER_POLICY_CHANGED_EVENT,
  PersonalProviderKeysSection,
} from "./personal-provider-keys-section";

const saved: CredentialMetadata = {
  provider: "openai",
  id: "credential-1",
  revision: 4,
  createdAt: "2026-09-30T10:00:00.000Z",
  updatedAt: "2026-09-30T11:00:00.000Z",
  validationStatus: "unverified",
  validatedAt: null,
  requiresReplacement: false,
};

function api(overrides: Record<string, unknown> = {}) {
  return {
    listProviderCredentials: mock(async () => ({ credentials: [] as CredentialMetadata[] })),
    putProviderCredential: mock(async () => ({ credential: saved, committed: true as const })),
    validateProviderCredential: mock(async () => ({
      credential: { ...saved, validationStatus: "accepted" as const, validatedAt: "2026-09-30T12:00:00.000Z" },
      committed: false as const,
    })),
    deleteProviderCredential: mock(async () => ({ deleted: true as const, committed: true as const })),
    ...overrides,
  };
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
});

describe("PersonalProviderKeysSection", () => {
  test("stays hidden when the gated list says personal keys are disabled", async () => {
    const credentialApi = api({
      listProviderCredentials: mock(async () => {
        throw new ProviderCredentialApiError(
          404,
          "personal_credentials_disabled",
          false,
          false,
          null,
        );
      }),
    });
    const view = render(<PersonalProviderKeysSection credentialApi={credentialApi} />);

    await waitFor(() => expect(credentialApi.listProviderCredentials).toHaveBeenCalledTimes(1));
    expect(view.queryByRole("heading", { name: "Personal provider keys" })).toBeNull();
  });

  test("shows an honest retry for transient and custody failures", async () => {
    const list = mock(async () => {
      throw new ProviderCredentialApiError(
        503,
        "credential_custody_unavailable",
        false,
        true,
        "contact_operator",
      );
    });
    const view = render(<PersonalProviderKeysSection credentialApi={api({ listProviderCredentials: list })} />);

    expect((await view.findByRole("alert")).textContent).toContain("Contact the Server operator");
    expect(view.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  test("saves a transient secret, clears it, emits refresh, and links to model choice", async () => {
    const credentialApi = api();
    let changes = 0;
    window.addEventListener(PERSONAL_PROVIDER_CREDENTIALS_CHANGED_EVENT, () => { changes += 1; }, { once: true });
    const view = render(<PersonalProviderKeysSection credentialApi={credentialApi} showServerAdminLink />);

    await view.findByRole("heading", { name: "Personal provider keys" });
    fireEvent.click(view.getByRole("button", { name: "Add Anthropic key" }));
    const input = view.getByLabelText("New Anthropic API key") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-private-value" } });
    fireEvent.click(view.getByRole("button", { name: "Save key" }));

    await waitFor(() => expect(credentialApi.putProviderCredential).toHaveBeenCalledWith(
      "anthropic",
      { apiKey: "sk-private-value" },
    ));
    await waitFor(() => expect(changes).toBe(1));
    expect(view.queryByDisplayValue("sk-private-value")).toBeNull();
    expect(view.queryByText("sk-private-value")).toBeNull();
    expect(view.getByRole("link", { name: "Choose a model for your Genie." }).getAttribute("href"))
      .toBe("/settings#model");
    expect(view.getByRole("link", { name: "Server Admin" }).getAttribute("href"))
      .toBe("/admin#provider-credentials");
  });

  test("uses revisions for replace, validation, and delete and refreshes on policy changes", async () => {
    const accepted = { ...saved, validationStatus: "accepted" as const, validatedAt: "2026-09-30T12:00:00.000Z" };
    const list = mock(async () => ({ credentials: [saved] }));
    const credentialApi = api({
      listProviderCredentials: list,
      putProviderCredential: mock(async () => ({ credential: { ...saved, revision: 5 }, committed: true as const })),
      validateProviderCredential: mock(async () => ({ credential: accepted, committed: false as const })),
    });
    const view = render(<PersonalProviderKeysSection credentialApi={credentialApi} />);

    await view.findByText("Not validated");
    fireEvent.click(view.getByRole("button", { name: "Replace OpenAI key" }));
    fireEvent.change(view.getByLabelText("Replacement OpenAI API key"), {
      target: { value: "replacement-secret" },
    });
    fireEvent.click(view.getByRole("button", { name: "Replace key" }));
    await waitFor(() => expect(credentialApi.putProviderCredential).toHaveBeenCalledWith(
      "openai",
      { apiKey: "replacement-secret", expectedRevision: 4 },
    ));

    fireEvent.click(view.getByRole("button", { name: "Validate OpenAI key" }));
    await waitFor(() => expect(credentialApi.validateProviderCredential).toHaveBeenCalledWith(
      "openai",
      { expectedRevision: 5 },
    ));

    fireEvent.click(view.getByRole("button", { name: "Delete OpenAI key" }));
    fireEvent.click(view.getByRole("button", { name: "Delete key" }));
    await waitFor(() => expect(credentialApi.deleteProviderCredential).toHaveBeenCalledWith(
      "openai",
      { expectedRevision: 4 },
    ));

    act(() => window.dispatchEvent(new Event(PERSONAL_PROVIDER_POLICY_CHANGED_EVENT)));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  test("hides an already-open section when the server policy is switched off", async () => {
    let reads = 0;
    const list = mock(async () => {
      if (reads++ === 0) return { credentials: [] as CredentialMetadata[] };
      throw new ProviderCredentialApiError(
        404,
        "personal_credentials_disabled",
        false,
        false,
        null,
      );
    });
    const view = render(<PersonalProviderKeysSection credentialApi={api({ listProviderCredentials: list })} />);
    await view.findByRole("heading", { name: "Personal provider keys" });

    act(() => window.dispatchEvent(new Event(PERSONAL_PROVIDER_POLICY_CHANGED_EVENT)));

    await waitFor(() => expect(view.queryByRole("heading", { name: "Personal provider keys" })).toBeNull());
    expect(list).toHaveBeenCalledTimes(2);
  });

  test("hides stale key controls when validation discovers the switch is off", async () => {
    let reads = 0;
    const list = mock(async () => {
      if (reads++ === 0) return { credentials: [saved] };
      throw new ProviderCredentialApiError(404, "personal_credentials_disabled", false, false, null);
    });
    const validate = mock(async () => {
      throw new ProviderCredentialApiError(404, "personal_credentials_disabled", false, false, null);
    });
    const view = render(<PersonalProviderKeysSection credentialApi={api({
      listProviderCredentials: list,
      validateProviderCredential: validate,
    })} />);

    await view.findByText("Not validated");
    fireEvent.click(view.getByRole("button", { name: "Validate OpenAI key" }));
    await waitFor(() => expect(view.queryByRole("heading", { name: "Personal provider keys" })).toBeNull());
    expect(validate).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(2);
  });

  test("rereads after an uncertain failed save without replaying the write", async () => {
    let reads = 0;
    const list = mock(async () => ({
      credentials: reads++ === 0 ? [] : [saved],
    }));
    const put = mock(async () => {
      throw new Error("connection closed");
    });
    const view = render(<PersonalProviderKeysSection credentialApi={api({
      listProviderCredentials: list,
      putProviderCredential: put,
    })} />);

    await view.findByRole("heading", { name: "Personal provider keys" });
    fireEvent.click(view.getByRole("button", { name: "Add Anthropic key" }));
    fireEvent.change(view.getByLabelText("New Anthropic API key"), {
      target: { value: "discard-after-request" },
    });
    fireEvent.click(view.getByRole("button", { name: "Save key" }));

    expect((await view.findByRole("alert")).textContent).toContain("could not confirm whether the key was saved");
    expect(list).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(1);
    expect(view.queryByDisplayValue("discard-after-request")).toBeNull();
    expect(view.getByText(/revision 4/)).toBeTruthy();
  });

  test("rereads metadata after a revision conflict and never retries the write", async () => {
    const newer = { ...saved, revision: 5 };
    let reads = 0;
    const list = mock(async () => ({ credentials: [reads++ === 0 ? saved : newer] }));
    const replace = mock(async () => {
      throw new ProviderCredentialApiError(
        409,
        "credential_conflict",
        false,
        false,
        "reread_metadata",
      );
    });
    const view = render(<PersonalProviderKeysSection credentialApi={api({
      listProviderCredentials: list,
      putProviderCredential: replace,
    })} />);

    await view.findByText("Not validated");
    fireEvent.click(view.getByRole("button", { name: "Replace OpenAI key" }));
    fireEvent.change(view.getByLabelText("Replacement OpenAI API key"), {
      target: { value: "do-not-retain" },
    });
    fireEvent.click(view.getByRole("button", { name: "Replace key" }));

    expect((await view.findByRole("alert")).textContent).toContain("changed in another tab");
    expect(list).toHaveBeenCalledTimes(2);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(view.queryByDisplayValue("do-not-retain")).toBeNull();
    expect(view.getByText(/revision 5/)).toBeTruthy();
  });
});
