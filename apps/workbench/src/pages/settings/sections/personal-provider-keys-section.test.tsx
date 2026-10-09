import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProviderCredentialApiError, type CredentialMetadata, type PersonalProviderCatalogEntry } from "@nautilo/api-client/browser";
import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";
import { PERSONAL_PROVIDER_CREDENTIALS_CHANGED_EVENT, PERSONAL_PROVIDER_POLICY_CHANGED_EVENT, PersonalProviderKeysSection } from "./personal-provider-keys-section";

const saved: CredentialMetadata = {
  provider: "openai", id: "credential-1", revision: 4,
  createdAt: "2026-09-30T10:00:00.000Z", updatedAt: "2026-09-30T11:00:00.000Z",
  validationStatus: "unverified", validatedAt: null, requiresReplacement: false,
  masked: "sk-…alue", destination: "https://api.openai.com/v1", receiptReadStatus: "unknown",
};

const providers: PersonalProviderCatalogEntry[] = [
  { id: "openai", name: "OpenAI", purpose: "OpenAI text", personalCapabilities: ["chat", "research"], destination: "https://api.openai.com/v1" },
  { id: "openrouter", name: "OpenRouter", purpose: "Router", personalCapabilities: ["chat", "research", "decision"], destination: "https://openrouter.ai/api/v1" },
  { id: "surplus", name: "Surplus Intelligence", purpose: "Marketplace", personalCapabilities: ["chat", "research", "decision"], destination: "https://api.surplus.ai/v1" },
  { id: "anthropic", name: "Anthropic", purpose: "Anthropic", personalCapabilities: ["chat", "research"], destination: "https://api.anthropic.com/v1" },
  { id: "tavily", name: "Tavily", purpose: "Search", personalCapabilities: ["research"], destination: null },
];

function api(overrides: Record<string, unknown> = {}) {
  return {
    listProviderCredentials: mock(async () => ({ credentials: [] as CredentialMetadata[], providers })),
    putProviderCredential: mock(async (provider: string) => ({ credential: { ...saved, provider }, committed: true as const })),
    validateProviderCredential: mock(async () => ({ credential: saved, committed: false as const })),
    deleteProviderCredential: mock(async () => ({ deleted: true as const, committed: true as const })),
    ...overrides,
  };
}

function listResponse(credentials: CredentialMetadata[] = []) { return { credentials, providers }; }
async function enterSecret(input: HTMLElement, value: string) {
  await userEvent.setup({ document: globalThis.document }).type(input, value);
}

beforeEach(() => { reapplyHappyDomGlobals(); cleanup(); });

describe("PersonalProviderKeysSection", () => {
  test("renders stable inert rows and honest coverage while the gated read is pending", async () => {
    let resolve!: (value: { credentials: CredentialMetadata[]; providers: PersonalProviderCatalogEntry[] }) => void;
    const pending = new Promise<{ credentials: CredentialMetadata[]; providers: PersonalProviderCatalogEntry[] }>((done) => { resolve = done; });
    const view = render(<PersonalProviderKeysSection credentialApi={api({ listProviderCredentials: mock(() => pending) })} />);

    expect(view.getByText("Loading saved key status…")).toBeTruthy();
    expect(view.getByRole("img", { name: "Chat: Checking coverage…" })).toBeTruthy();
    expect((view.getByRole("button", { name: "Add OpenAI key" }) as HTMLButtonElement).disabled).toBeTrue();
    expect(view.container.textContent).toContain("Checking saved status…");
    expect(view.getByRole("link", { name: "View your costs" }).getAttribute("href")).toBe("/account/costs");
    await act(async () => resolve({ credentials: [], providers }));
  });

  test("distinguishes disabled policy and permission denial without retry actions", async () => {
    const disabled = render(<PersonalProviderKeysSection credentialApi={api({ listProviderCredentials: mock(async () => { throw new ProviderCredentialApiError(404, "personal_credentials_disabled", false, false, null); }) })} />);
    expect(await disabled.findByText("Personal API keys are disabled on this server.")).toBeTruthy();
    expect(disabled.queryByRole("button", { name: "Retry" })).toBeNull();
    cleanup();
    const forbidden = render(<PersonalProviderKeysSection credentialApi={api({ listProviderCredentials: mock(async () => { throw new ProviderCredentialApiError(403, "personal_credentials_forbidden", false, false, null); }) })} />);
    expect(await forbidden.findByText("You do not have permission to manage personal API keys.")).toBeTruthy();
    expect(forbidden.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  test("shows only the warning and costs link when off without saved keys", async () => {
    const view = render(<PersonalProviderKeysSection showServerAdminLink credentialApi={api({
      listProviderCredentials: mock(async () => ({ ...listResponse(), allowPersonalProviderKeys: false })),
    })} />);
    await view.findByText("Personal API keys are disabled on this server.");
    expect(view.container.querySelectorAll("label").length).toBe(0);
    expect(view.queryByTestId("personal-provider-key-coverage")).toBeNull();
    expect(view.queryAllByRole("button")).toHaveLength(0);
    expect(view.queryByText("Get a key")).toBeNull();
    expect(view.queryByRole("link", { name: "Server Admin" })).toBeNull();
    expect(view.getByRole("link", { name: "View your costs" })).toBeTruthy();
  });

  test("shows saved rows only when off and removes the last key by confirmed revision", async () => {
    const keyApi = api({ listProviderCredentials: mock(async () => ({
      ...listResponse([{ ...saved, masked: null, requiresReplacement: true, receiptReadStatus: "unavailable" as const }]),
      allowPersonalProviderKeys: false,
    })) });
    const view = render(<PersonalProviderKeysSection credentialApi={keyApi} />);
    const remove = await view.findByRole("button", { name: "Delete OpenAI key" });
    expect((remove as HTMLButtonElement).disabled).toBeFalse();
    expect([...view.container.querySelectorAll("label")].map((node) => node.textContent)).toEqual(["OpenAI"]);
    expect(view.queryByTestId("personal-provider-key-coverage")).toBeNull();
    expect(view.queryByText("Get a key")).toBeNull();
    expect(view.queryByText("Replacement required")).toBeNull();
    expect(view.container.textContent).not.toContain("can run eligible requests");
    expect(view.queryByRole("button", { name: /Add|Replace|Validate/ })).toBeNull();
    fireEvent.click(remove);
    expect(keyApi.deleteProviderCredential).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "Delete key" }));
    await waitFor(() => expect(keyApi.deleteProviderCredential).toHaveBeenCalledWith("openai", { expectedRevision: 4 }));
    await view.findByText("Personal API keys are disabled on this server.");
    expect(view.container.querySelectorAll("label").length).toBe(0);
    expect(keyApi.putProviderCredential).not.toHaveBeenCalled();
    expect(keyApi.validateProviderCredential).not.toHaveBeenCalled();
  });

  test("clears a draft on a successful off response and keeps refresh compact", async () => {
    let resolveRefresh!: (value: ReturnType<typeof listResponse> & { allowPersonalProviderKeys: boolean }) => void;
    const pending = new Promise<ReturnType<typeof listResponse> & { allowPersonalProviderKeys: boolean }>((resolve) => { resolveRefresh = resolve; });
    let reads = 0;
    const keyApi = api({ listProviderCredentials: mock(() => {
      if (reads++ === 0) return Promise.resolve(listResponse([saved]));
      if (reads === 2) return Promise.resolve({ ...listResponse([saved]), allowPersonalProviderKeys: false });
      return pending;
    }) });
    const view = render(<PersonalProviderKeysSection credentialApi={keyApi} />);
    fireEvent.click(await view.findByRole("button", { name: "Add Anthropic key" }));
    await enterSecret(view.getByLabelText("New Anthropic API key"), "discard-on-policy-off");
    fireEvent(window, new Event("focus"));
    await view.findByText("Personal API keys are disabled on this server. Your saved keys won’t be used. You can delete them below.");
    expect(view.queryByDisplayValue("discard-on-policy-off")).toBeNull();
    fireEvent(window, new Event("focus"));
    expect(view.container.querySelectorAll("label").length).toBe(1);
    expect(view.queryByTestId("personal-provider-key-coverage")).toBeNull();
    expect((view.getByRole("button", { name: "Delete OpenAI key" }) as HTMLButtonElement).disabled).toBeTrue();
    await act(async () => resolveRefresh({ ...listResponse(), allowPersonalProviderKeys: false }));
    await view.findByText("Personal API keys are disabled on this server.");
    expect(view.container.querySelectorAll("label").length).toBe(0);
  });

  test("drops an old validation error after a successful off-policy refresh", async () => {
    let reads = 0;
    const keyApi = api({
      listProviderCredentials: mock(async () => ({ ...listResponse([saved]), allowPersonalProviderKeys: reads++ === 0 })),
      validateProviderCredential: mock(async () => { throw new Error("temporary validation failure"); }),
    });
    const view = render(<PersonalProviderKeysSection credentialApi={keyApi} />);
    fireEvent.click(await view.findByRole("button", { name: "Validate OpenAI key" }));
    await view.findByRole("alert");
    fireEvent(window, new Event("focus"));
    await view.findByText("Personal API keys are disabled on this server. Your saved keys won’t be used. You can delete them below.");
    expect(view.queryByRole("alert")).toBeNull();
    expect((view.getByRole("button", { name: "Delete OpenAI key" }) as HTMLButtonElement).disabled).toBeFalse();
  });

  test("rereads an off-state deletion conflict without replaying and uses the new revision", async () => {
    let reads = 0;
    const keyApi = api({
      listProviderCredentials: mock(async () => ({ ...listResponse([{ ...saved, revision: reads++ === 0 ? 4 : 5 }]), allowPersonalProviderKeys: false })),
      deleteProviderCredential: mock(async () => { throw new ProviderCredentialApiError(409, "credential_conflict", false, true, "reread_metadata"); }),
    });
    const view = render(<PersonalProviderKeysSection credentialApi={keyApi} />);
    fireEvent.click(await view.findByRole("button", { name: "Delete OpenAI key" }));
    fireEvent.click(view.getByRole("button", { name: "Delete key" }));
    expect(await view.findByRole("alert")).toBeTruthy();
    expect(keyApi.listProviderCredentials).toHaveBeenCalledTimes(2);
    expect(keyApi.deleteProviderCredential).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole("button", { name: "Delete OpenAI key" }));
    fireEvent.click(view.getByRole("button", { name: "Delete key" }));
    await waitFor(() => expect(keyApi.deleteProviderCredential).toHaveBeenLastCalledWith("openai", { expectedRevision: 5 }));
  });

  test("invalidates delete confirmation when focus refresh replaces the credential", async () => {
    let resolveRefresh!: (value: ReturnType<typeof listResponse>) => void;
    let reads = 0;
    const keyApi = api({
      listProviderCredentials: mock(() => reads++ === 0
        ? Promise.resolve(listResponse([saved]))
        : new Promise<ReturnType<typeof listResponse>>((resolve) => { resolveRefresh = resolve; })),
    });
    const view = render(<PersonalProviderKeysSection credentialApi={keyApi} />);
    fireEvent.click(await view.findByRole("button", { name: "Delete OpenAI key" }));
    expect(view.getByRole("button", { name: "Delete key" })).toBeTruthy();

    fireEvent(window, new Event("focus"));
    await act(async () => resolveRefresh(listResponse([{ ...saved, id: "credential-2", revision: 5, updatedAt: "2026-09-30T12:00:00.000Z" }])));

    expect(view.queryByRole("button", { name: "Delete key" })).toBeNull();
    expect(keyApi.deleteProviderCredential).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "Delete OpenAI key" }));
    fireEvent.click(view.getByRole("button", { name: "Delete key" }));
    await waitFor(() => expect(keyApi.deleteProviderCredential).toHaveBeenCalledWith("openai", { expectedRevision: 5 }));
  });

  test("offers retry only for transient load failures", async () => {
    const view = render(<PersonalProviderKeysSection credentialApi={api({ listProviderCredentials: mock(async () => { throw new ProviderCredentialApiError(503, "credential_custody_unavailable", false, true, "contact_operator"); }) })} />);
    expect((await view.findByRole("alert")).textContent).toContain("Contact the Server operator");
    expect(view.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  test("treats an expired session as sign-in state without a retry action", async () => {
    const view = render(<PersonalProviderKeysSection credentialApi={api({ listProviderCredentials: mock(async () => { throw { status: 401 }; }) })} />);
    expect(await view.findByText("Your session ended. Sign in again to manage personal API keys.")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  test("uses shared order, keeps coverage, and omits gateway enrollment", async () => {
    const view = render(<PersonalProviderKeysSection credentialApi={api()} />);
    await waitFor(() => expect(view.container.textContent).toContain("No key saved"));
    const labels = [...view.container.querySelectorAll("label")].map((node) => node.textContent);
    expect(labels.indexOf("Surplus Intelligence")).toBe(labels.indexOf("OpenRouter") + 1);
    expect(view.getByTestId("personal-provider-key-coverage").textContent).toContain("Chat");
    expect(view.getByTestId("personal-provider-key-coverage").textContent).toContain("Research");
    expect(view.getByTestId("personal-provider-key-coverage").textContent).toContain("Decisions");
    expect(view.getByText(/Surplus Decisions also require a pilot-enabled account/)).toBeTruthy();
    expect(view.queryByRole("button", { name: /Gateway key/ })).toBeNull();
    expect(view.queryByText("OpenAI-Compatible Gateway")).toBeNull();
  });

  test("shows a legacy gateway credential as delete-only and deletes by revision after confirmation", async () => {
    const gateway = { ...saved, provider: "gateway", id: "legacy-gateway", masked: "gw-…7890" };
    const keyApi = api({ listProviderCredentials: mock(async () => ({
      credentials: [gateway],
      providers: [...providers, { id: "gateway", name: "OpenAI-Compatible Gateway", purpose: "Legacy", personalCapabilities: ["chat"], destination: null }],
    })) });
    const view = render(<PersonalProviderKeysSection credentialApi={keyApi} />);
    expect(await view.findByText("gw-…7890")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Replace gateway key" })).toBeNull();
    expect(view.queryByRole("button", { name: "Validate gateway key" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Delete legacy gateway key" }));
    fireEvent.click(view.getByRole("button", { name: "Delete key" }));
    await waitFor(() => expect(keyApi.deleteProviderCredential).toHaveBeenCalledWith("gateway", { expectedRevision: 4 }));
  });

  test("refreshes on policy changes and ignores an older ready response after switch-off", async () => {
    let finishFirst!: (value: { credentials: CredentialMetadata[]; providers: PersonalProviderCatalogEntry[] }) => void;
    const first = new Promise<{ credentials: CredentialMetadata[]; providers: PersonalProviderCatalogEntry[] }>((resolve) => { finishFirst = resolve; });
    let reads = 0;
    const list = mock(() => reads++ === 0 ? first : Promise.reject(new ProviderCredentialApiError(404, "personal_credentials_disabled", false, false, null)));
    const view = render(<PersonalProviderKeysSection credentialApi={api({ listProviderCredentials: list })} />);
    act(() => window.dispatchEvent(new Event(PERSONAL_PROVIDER_POLICY_CHANGED_EVENT)));
    await view.findByText("Personal API keys are disabled on this server.");
    await act(async () => finishFirst({ credentials: [], providers }));
    expect(view.queryByRole("button", { name: "Add OpenAI key" })).toBeNull();
  });

  test("preserves an open secret draft during focus refresh and clears it only after policy denial", async () => {
    let rejectRefresh!: (error: unknown) => void;
    const pending = new Promise<never>((_resolve, reject) => { rejectRefresh = reject; });
    let reads = 0;
    const list = mock(() => reads++ === 0 ? Promise.resolve(listResponse()) : pending);
    const view = render(<PersonalProviderKeysSection credentialApi={api({ listProviderCredentials: list })} />);
    fireEvent.click(await view.findByRole("button", { name: "Add Anthropic key" }));
    const input = view.getByLabelText("New Anthropic API key") as HTMLInputElement;
    await enterSecret(input, "keep-until-policy-known");
    fireEvent(window, new Event("focus"));
    expect((view.getByDisplayValue("keep-until-policy-known") as HTMLInputElement).disabled).toBeTrue();
    await act(async () => rejectRefresh(new ProviderCredentialApiError(404, "personal_credentials_disabled", false, false, null)));
    await view.findByText("Personal API keys are disabled on this server.");
    expect(view.queryByDisplayValue("keep-until-policy-known")).toBeNull();
  });

  test("explains unavailable receipt reads as delayed cost visibility without blocking inference", async () => {
    const credential = { ...saved, receiptReadStatus: "unavailable" as const };
    const view = render(<PersonalProviderKeysSection credentialApi={api({ listProviderCredentials: mock(async () => ({ credentials: [credential], providers })) })} />);
    expect(await view.findByText("This key can run eligible requests. Some costs may appear later because it cannot currently read cost receipts.")).toBeTruthy();
  });

  test("clears an open secret draft when a focus read confirms the session ended", async () => {
    let reads = 0;
    const list = mock(async () => {
      if (reads++ === 0) return listResponse();
      throw { status: 401 };
    });
    const view = render(<PersonalProviderKeysSection credentialApi={api({ listProviderCredentials: list })} />);
    fireEvent.click(await view.findByRole("button", { name: "Add Anthropic key" }));
    await enterSecret(view.getByLabelText("New Anthropic API key"), "discard-on-sign-out");
    fireEvent(window, new Event("focus"));
    await view.findByText("Your session ended. Sign in again to manage personal API keys.");
    expect(view.queryByDisplayValue("discard-on-sign-out")).toBeNull();
    expect(view.queryByLabelText("New Anthropic API key")).toBeNull();
  });

  test("counts only usable saved chat credentials as coverage and shows masked values only", async () => {
    const credentials: CredentialMetadata[] = [
      { ...saved, provider: "anthropic", validationStatus: "unavailable", masked: "ant-…1234" },
      { ...saved, id: "credential-2", provider: "openai", validationStatus: "rejected", requiresReplacement: true },
      { ...saved, id: "credential-3", provider: "server-only", validationStatus: "accepted", masked: "legacy-…7890" },
    ];
    const view = render(<PersonalProviderKeysSection credentialApi={api({ listProviderCredentials: mock(async () => listResponse(credentials)) })} />);
    expect(await view.findByText("ant-…1234")).toBeTruthy();
    expect(view.getAllByLabelText("Anthropic: API key configured")).toHaveLength(2);
    expect(view.getAllByLabelText("OpenAI: API key not configured")).toHaveLength(2);
    expect(view.getByTestId("personal-provider-key-coverage").textContent).not.toContain("server-only");
    expect(view.container.textContent).not.toContain("unmasked-secret");
    expect(view.getByRole("button", { name: "Delete legacy server-only key" })).toBeTruthy();
  });

  test("saves a transient secret, clears it, emits refresh, and links each real capability selector", async () => {
    const keyApi = api();
    let changes = 0;
    window.addEventListener(PERSONAL_PROVIDER_CREDENTIALS_CHANGED_EVENT, () => { changes++; }, { once: true });
    const view = render(<PersonalProviderKeysSection credentialApi={keyApi} />);
    const add = await view.findByRole("button", { name: "Add Anthropic key" });
    fireEvent.click(add);
    await enterSecret(view.getByLabelText("New Anthropic API key"), "sk-private-value");
    fireEvent.click(view.getByRole("button", { name: "Save key" }));
    await waitFor(() => expect(keyApi.putProviderCredential).toHaveBeenCalledWith("anthropic", { apiKey: "sk-private-value" }));
    expect(changes).toBe(1);
    expect(view.queryByDisplayValue("sk-private-value")).toBeNull();
    expect(view.getByRole("link", { name: "Choose a model for your Genie." })).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Add Tavily key" }));
    await enterSecret(view.getByLabelText("New Tavily API key"), "tvly-personal");
    fireEvent.click(view.getByRole("button", { name: "Save key" }));
    await waitFor(() => expect(keyApi.putProviderCredential).toHaveBeenCalledWith("tavily", { apiKey: "tvly-personal" }));
    expect(view.queryByRole("link", { name: "Choose a model for your Genie." })).toBeNull();
    expect(view.getByRole("link", { name: "Configure Research and Decision models." })).toBeTruthy();
  });

  test("uses current revisions for replace, validation, and deletion", async () => {
    const keyApi = api({
      listProviderCredentials: mock(async () => listResponse([saved])),
      putProviderCredential: mock(async () => ({ credential: { ...saved, revision: 5 }, committed: true as const })),
      validateProviderCredential: mock(async () => ({ credential: { ...saved, revision: 5, validationStatus: "accepted" as const }, committed: false as const })),
    });
    const view = render(<PersonalProviderKeysSection credentialApi={keyApi} />);
    fireEvent.click(await view.findByRole("button", { name: "Replace OpenAI key" }));
    await enterSecret(view.getByLabelText("Replacement OpenAI API key"), "replacement");
    fireEvent.click(view.getByRole("button", { name: "Replace key" }));
    await waitFor(() => expect(keyApi.putProviderCredential).toHaveBeenCalledWith("openai", { apiKey: "replacement", expectedRevision: 4 }));
    fireEvent.click(view.getByRole("button", { name: "Validate OpenAI key" }));
    await waitFor(() => expect(keyApi.validateProviderCredential).toHaveBeenCalledWith("openai", { expectedRevision: 5 }));
    fireEvent.click(view.getByRole("button", { name: "Delete OpenAI key" }));
    fireEvent.click(view.getByRole("button", { name: "Delete key" }));
    await waitFor(() => expect(keyApi.deleteProviderCredential).toHaveBeenCalledWith("openai", { expectedRevision: 5 }));
  });

  test("clears stale controls when validation discovers policy was switched off", async () => {
    let reads = 0;
    const list = mock(async () => reads++ === 0 ? listResponse([saved]) : Promise.reject(new ProviderCredentialApiError(404, "personal_credentials_disabled", false, false, null)));
    const validate = mock(async () => { throw new ProviderCredentialApiError(404, "personal_credentials_disabled", false, false, null); });
    const view = render(<PersonalProviderKeysSection credentialApi={api({ listProviderCredentials: list, validateProviderCredential: validate })} />);
    fireEvent.click(await view.findByRole("button", { name: "Validate OpenAI key" }));
    await view.findByText("Personal API keys are disabled on this server.");
    expect(view.queryByRole("button", { name: "Add OpenAI key" })).toBeNull();
    expect(validate).toHaveBeenCalledTimes(1);
  });

  test("rereads after an uncertain save without replaying or retaining the secret", async () => {
    let reads = 0;
    const list = mock(async () => listResponse(reads++ === 0 ? [] : [saved]));
    const put = mock(async () => { throw new Error("connection closed"); });
    const view = render(<PersonalProviderKeysSection credentialApi={api({ listProviderCredentials: list, putProviderCredential: put })} />);
    fireEvent.click(await view.findByRole("button", { name: "Add Anthropic key" }));
    await enterSecret(view.getByLabelText("New Anthropic API key"), "discard-after-request");
    fireEvent.click(view.getByRole("button", { name: "Save key" }));
    expect((await view.findByRole("alert")).textContent).toContain("could not confirm whether the key was saved");
    expect(list).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(1);
    expect(view.queryByDisplayValue("discard-after-request")).toBeNull();
  });

  test("rereads revision conflicts without replaying the write", async () => {
    let reads = 0;
    const list = mock(async () => listResponse([{ ...saved, revision: reads++ === 0 ? 4 : 5 }]));
    const put = mock(async () => { throw new ProviderCredentialApiError(409, "credential_conflict", false, false, "reread_metadata"); });
    const view = render(<PersonalProviderKeysSection credentialApi={api({ listProviderCredentials: list, putProviderCredential: put })} />);
    fireEvent.click(await view.findByRole("button", { name: "Replace OpenAI key" }));
    await enterSecret(view.getByLabelText("Replacement OpenAI API key"), "do-not-retain");
    fireEvent.click(view.getByRole("button", { name: "Replace key" }));
    expect((await view.findByRole("alert")).textContent).toContain("changed in another tab");
    expect(list).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(1);
  });

  test("keeps a saved key deleteable when an older server returns an empty catalogue", async () => {
    const keyApi = api({ listProviderCredentials: mock(async () => ({ credentials: [saved], providers: [] })) });
    const view = render(<PersonalProviderKeysSection credentialApi={keyApi} />);
    const remove = await view.findByRole("button", { name: "Delete legacy OpenAI key" });
    expect(view.queryByRole("button", { name: "Replace OpenAI key" })).toBeNull();
    fireEvent.click(remove);
    fireEvent.click(view.getByRole("button", { name: "Delete key" }));
    await waitFor(() => expect(keyApi.deleteProviderCredential).toHaveBeenCalledWith("openai", { expectedRevision: 4 }));
  });
});


test("service keys use server-advertised capabilities and link the existing chat workflow", async () => {
  const browserProvider: PersonalProviderCatalogEntry = { id: "browser-use", name: "Browser Use", purpose: "Browsing", personalCapabilities: ["browsing"], destination: null };
  const credential = { ...saved, provider: "browser-use" };
  const view = render(<PersonalProviderKeysSection credentialApi={api({
    listProviderCredentials: mock(async () => ({ credentials: [credential], providers: [browserProvider] })),
  })} />);
  await waitFor(() => expect(view.getByText("Eligible for website browsing and actions.")).toBeTruthy());
  expect(view.getByRole("link", { name: "Open your chats." }).getAttribute("href")).toBe("/");
  expect(view.getByText(/Existing website accounts keep the key/)).toBeTruthy();
});

test("an older server cannot inherit newly advertised client service support", async () => {
  const view = render(<PersonalProviderKeysSection credentialApi={api({
    listProviderCredentials: mock(async () => ({ credentials: [{ ...saved, provider: "browser-use" }], providers: [
      { id: "browser-use", name: "Browser Use", purpose: "Stored", personalCapabilities: [], destination: null },
    ] })),
  })} />);
  await waitFor(() => expect(view.getByRole("button", { name: "Delete Browser Use key" })).toBeTruthy());
  expect(view.queryByText("Eligible for website browsing and actions.")).toBeNull();
  expect(view.queryByRole("link", { name: "Open your chats." })).toBeNull();
});
