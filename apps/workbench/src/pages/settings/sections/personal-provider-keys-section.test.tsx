import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ProviderCredentialApiError,
  type CredentialMetadata,
  type PersonalProviderCatalogEntry,
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
  masked: "sk-…alue",
  destination: "https://api.openai.com/v1",
  receiptReadStatus: "unknown",
};

const providers: PersonalProviderCatalogEntry[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    purpose: "Anthropic models",
    signupUrl: "https://platform.claude.com/settings/keys",
    formatHint: "sk-ant-api03-...",
    personalCapabilities: ["chat"],
    destination: "https://api.anthropic.com/v1",
  },
  {
    id: "openai",
    name: "OpenAI",
    purpose: "GPT models + embeddings",
    signupUrl: "https://platform.openai.com/api-keys",
    formatHint: "sk-proj-...",
    personalCapabilities: ["chat"],
    destination: "https://api.openai.com/v1",
  },
  {
    id: "tavily",
    name: "Tavily",
    purpose: "Web search",
    signupUrl: "https://app.tavily.com/home",
    formatHint: "tvly-...",
    personalCapabilities: [],
    destination: null,
  },
  {
    id: "gateway",
    name: "Gateway",
    purpose: "Custom gateway",
    personalCapabilities: ["chat"],
    destination: "https://gateway.example.test/v1",
  },
  {
    id: "nautilo-gateway",
    name: "Nautilo Gateway",
    purpose: "Nautilo relay gateway",
    personalCapabilities: ["chat"],
    destination: null,
  },
];

function listResponse(credentials: CredentialMetadata[] = []) {
  return { credentials, providers };
}

function api(overrides: Record<string, unknown> = {}) {
  return {
    listProviderCredentials: mock(async () => listResponse()),
    putProviderCredential: mock(async (provider: string) => ({
      credential: { ...saved, provider },
      committed: true as const,
    })),
    validateProviderCredential: mock(async () => ({
      credential: { ...saved, validationStatus: "accepted" as const, validatedAt: "2026-09-30T12:00:00.000Z" },
      committed: false as const,
    })),
    deleteProviderCredential: mock(async () => ({ deleted: true as const, committed: true as const })),
    ...overrides,
  };
}

async function enterSecret(input: HTMLElement, value: string): Promise<void> {
  const user = userEvent.setup({ document: globalThis.document });
  await user.type(input, value);
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
});

describe("PersonalProviderKeysSection", () => {
  test("renders the section while provider metadata is loading", async () => {
    let finishLoad: ((result: ReturnType<typeof listResponse>) => void) | undefined;
    const pending = new Promise<ReturnType<typeof listResponse>>((resolve) => {
      finishLoad = resolve;
    });
    const view = render(<PersonalProviderKeysSection credentialApi={api({
      listProviderCredentials: mock(() => pending),
    })} />);

    expect(view.getByRole("heading", { name: "Personal API keys" })).toBeTruthy();
    expect(view.getByRole("link", { name: "View your costs" }).getAttribute("href"))
      .toBe("/account/costs");
    expect(view.getByText("Loading…")).toBeTruthy();

    await act(async () => finishLoad?.(listResponse()));
  });

  test("renders the disabled state returned by the gated list", async () => {
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

    expect(await view.findByRole("heading", { name: "Personal API keys" })).toBeTruthy();
    expect(view.getByText("Personal keys are disabled on this server.")).toBeTruthy();
    expect(view.queryByRole("button", { name: /key/i })).toBeNull();
  });

  test("renders the forbidden state returned by the gated list", async () => {
    const credentialApi = api({
      listProviderCredentials: mock(async () => {
        throw new ProviderCredentialApiError(
          403,
          "personal_credentials_forbidden",
          false,
          false,
          null,
        );
      }),
    });
    const view = render(<PersonalProviderKeysSection credentialApi={credentialApi} />);

    expect(await view.findByRole("heading", { name: "Personal API keys" })).toBeTruthy();
    expect(view.getByText("You are not allowed to set up personal keys.")).toBeTruthy();
    expect(view.queryByRole("button", { name: /key/i })).toBeNull();
  });

  test("ignores an older ready response after a newer policy denial", async () => {
    let finishFirstLoad: ((result: ReturnType<typeof listResponse>) => void) | undefined;
    const firstLoad = new Promise<ReturnType<typeof listResponse>>((resolve) => {
      finishFirstLoad = resolve;
    });
    let reads = 0;
    const list = mock(() => {
      if (reads++ === 0) return firstLoad;
      return Promise.reject(new ProviderCredentialApiError(
        404,
        "personal_credentials_disabled",
        false,
        false,
        null,
      ));
    });
    const view = render(<PersonalProviderKeysSection credentialApi={api({
      listProviderCredentials: list,
    })} />);

    act(() => window.dispatchEvent(new Event(PERSONAL_PROVIDER_POLICY_CHANGED_EVENT)));
    await view.findByText("Personal keys are disabled on this server.");
    await act(async () => finishFirstLoad?.(listResponse()));

    expect(view.getByText("Personal keys are disabled on this server.")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Add Anthropic key" })).toBeNull();
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

  test("renders the canonical response providers and a single personal Chat coverage row", async () => {
    const view = render(<PersonalProviderKeysSection credentialApi={api()} />);

    await view.findByRole("button", { name: "Add Anthropic key" });
    const providerButtons = view.getAllByRole("button", { name: /^Add .* key$/ });
    expect(providerButtons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Add OpenAI key",
      "Add Anthropic key",
      "Add Tavily key",
      "Add Gateway key",
    ]);
    const coverage = view.getByTestId("personal-provider-key-coverage");
    expect(coverage.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(coverage.textContent).toContain("Chat");
    expect(coverage.textContent).toContain("Anthropic");
    expect(coverage.textContent).toContain("OpenAI");
    expect(coverage.textContent).not.toContain("Tavily");
    expect(coverage.textContent).toContain("Gateway");
    expect(coverage.textContent).toContain(
      "Personal keys currently support personal chat and native tool-free text Tasks; other paid capabilities will be added later.",
    );
    expect(view.getByLabelText("OpenAI: API key not configured")).toBeTruthy();
    expect(view.getByRole("button", { name: "Add Gateway key" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Add Nautilo Gateway key" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Add Anthropic key" }));
    expect(view.getByPlaceholderText("sk-ant-api03-...")).toBeTruthy();
    expect(view.getAllByRole("link", { name: "Get a key", exact: true })[1]?.getAttribute("href"))
      .toBe("https://platform.claude.com/settings/keys");
  });

  test("shows only a masked preview and retains saved gateway keys as management-only rows", async () => {
    const gateway = { ...saved, provider: "gateway", id: "credential-gateway", masked: "gw-…7890" };
    const nautiloGateway = {
      ...saved,
      provider: "nautilo-gateway",
      id: "credential-nautilo-gateway",
      masked: "ngw-…1234",
    };
    const view = render(<PersonalProviderKeysSection credentialApi={api({
      listProviderCredentials: mock(async () => listResponse([gateway, nautiloGateway])),
    })} />);

    expect(await view.findByText("gw-…7890")).toBeTruthy();
    expect(view.getByText("ngw-…1234")).toBeTruthy();
    expect(view.getByRole("button", { name: "Replace Gateway key" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Validate Gateway key" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Delete Gateway key" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Replace Nautilo Gateway key" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Add Gateway key" })).toBeNull();
    expect(view.queryByRole("button", { name: "Add Nautilo Gateway key" })).toBeNull();
    expect(view.container.textContent).not.toContain("sk-private-value");
  });

  test("derives personal coverage only from usable saved account credentials", async () => {
    const credentials: CredentialMetadata[] = [
      { ...saved, provider: "anthropic", validationStatus: "unavailable" },
      {
        ...saved,
        id: "credential-2",
        provider: "openai",
        validationStatus: "rejected",
        requiresReplacement: true,
      },
      { ...saved, id: "credential-3", provider: "server-only", validationStatus: "accepted" },
    ];
    const view = render(<PersonalProviderKeysSection credentialApi={api({
      listProviderCredentials: mock(async () => listResponse(credentials)),
    })} />);

    await view.findByText("Validation unavailable");
    expect(view.getByLabelText("Anthropic: API key configured")).toBeTruthy();
    expect(view.getByLabelText("OpenAI: API key not configured")).toBeTruthy();
    expect(view.getByRole("button", { name: "Replace server-only key" })).toBeTruthy();
    expect(view.getByTestId("personal-provider-key-coverage").textContent).not.toContain("server-only");
  });

  test("keeps saved providers outside the current catalogue manageable without adding choices", async () => {
    const credentials: CredentialMetadata[] = [
      { ...saved, provider: "xai" },
      { ...saved, id: "credential-2", provider: "together" },
    ];
    const view = render(<PersonalProviderKeysSection credentialApi={api({
      listProviderCredentials: mock(async () => listResponse(credentials)),
    })} />);

    const xaiButton = await view.findByRole("button", { name: "Replace xai key" });
    expect(xaiButton).toBeTruthy();
    expect(view.getByRole("button", { name: "Replace together key" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Add xai key" })).toBeNull();
    expect(view.queryByRole("button", { name: "Add together key" })).toBeNull();
    expect(view.getAllByText(/This saved provider is outside the server’s current provider catalogue/))
      .toHaveLength(2);
    expect(xaiButton.closest(".grid")?.textContent).not.toContain(
      "Not used by personal chat or native tool-free text Tasks in this release.",
    );

    fireEvent.click(xaiButton);
    await enterSecret(view.getByLabelText("Replacement xai API key"), "legacy-replacement");
    fireEvent.click(view.getByRole("button", { name: "Replace key" }));
    await waitFor(() => expect(view.getByRole("status").textContent).toContain("Key saved and checked without making a paid request."));
    expect(view.getByRole("status").closest(".grid")?.textContent).not.toContain(
      "Not used by personal chat or native tool-free text Tasks in this release.",
    );
  });

  test("keeps saved keys manageable when an older response has no provider catalogue", async () => {
    const view = render(<PersonalProviderKeysSection credentialApi={api({
      listProviderCredentials: mock(async () => ({ credentials: [saved], providers: [] })),
    })} />);

    expect(await view.findByText(
      "Provider choices are temporarily unavailable. Saved keys can still be managed below.",
    )).toBeTruthy();
    expect(view.getByRole("button", { name: "Replace openai key" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Add openai key" })).toBeNull();
    expect(view.getByText(/This saved provider is outside the server’s current provider catalogue/))
      .toBeTruthy();
    expect(view.queryByRole("img", { name: "Chat: no supporting API key configured" })).toBeNull();
  });

  test("saves a transient secret, clears it, emits refresh, and links to model choice", async () => {
    const credentialApi = api();
    let changes = 0;
    window.addEventListener(PERSONAL_PROVIDER_CREDENTIALS_CHANGED_EVENT, () => { changes += 1; }, { once: true });
    const view = render(<PersonalProviderKeysSection credentialApi={credentialApi} showServerAdminLink />);

    await view.findByRole("heading", { name: "Personal API keys" });
    fireEvent.click(view.getByRole("button", { name: "Add Anthropic key" }));
    const input = view.getByLabelText("New Anthropic API key") as HTMLInputElement;
    await enterSecret(input, "sk-private-value");
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

  test("allows storing unsupported provider keys without linking them to model selection", async () => {
    const credentialApi = api();
    const view = render(<PersonalProviderKeysSection credentialApi={credentialApi} />);

    await view.findByRole("button", { name: "Add Tavily key" });
    fireEvent.click(view.getByRole("button", { name: "Add Tavily key" }));
    await enterSecret(view.getByLabelText("New Tavily API key"), "tvly-personal");
    fireEvent.click(view.getByRole("button", { name: "Save key" }));

    await waitFor(() => expect(credentialApi.putProviderCredential).toHaveBeenCalledWith(
      "tavily",
      { apiKey: "tvly-personal" },
    ));
    expect(view.getByRole("status").textContent).toContain("Key saved and checked without making a paid request.");
    expect(view.getByRole("status").textContent).toContain(
      "Not used by personal chat or native tool-free text Tasks in this release.",
    );
    expect(view.queryByRole("link", { name: "Choose a model for your Genie." })).toBeNull();
  });

  test("uses revisions for replace, validation, and delete and refreshes on policy changes", async () => {
    const accepted = { ...saved, validationStatus: "accepted" as const, validatedAt: "2026-09-30T12:00:00.000Z" };
    const list = mock(async () => listResponse([saved]));
    const credentialApi = api({
      listProviderCredentials: list,
      putProviderCredential: mock(async () => ({ credential: { ...saved, revision: 5 }, committed: true as const })),
      validateProviderCredential: mock(async () => ({ credential: accepted, committed: false as const })),
    });
    const view = render(<PersonalProviderKeysSection credentialApi={credentialApi} />);

    await view.findByText("Not validated");
    fireEvent.click(view.getByRole("button", { name: "Replace OpenAI key" }));
    await enterSecret(view.getByLabelText("Replacement OpenAI API key"), "replacement-secret");
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

  test("replaces an already-open section with the disabled state when policy is switched off", async () => {
    let reads = 0;
    const list = mock(async () => {
      if (reads++ === 0) return listResponse();
      throw new ProviderCredentialApiError(
        404,
        "personal_credentials_disabled",
        false,
        false,
        null,
      );
    });
    const view = render(<PersonalProviderKeysSection credentialApi={api({ listProviderCredentials: list })} />);
    await view.findByRole("heading", { name: "Personal API keys" });

    act(() => window.dispatchEvent(new Event(PERSONAL_PROVIDER_POLICY_CHANGED_EVENT)));

    await view.findByText("Personal keys are disabled on this server.");
    expect(view.getByRole("heading", { name: "Personal API keys" })).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(2);
  });

  test("clears stale key controls when validation discovers the switch is off", async () => {
    let reads = 0;
    const list = mock(async () => {
      if (reads++ === 0) return listResponse([saved]);
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
    await view.findByText("Personal keys are disabled on this server.");
    expect(view.queryByRole("button", { name: "Validate OpenAI key" })).toBeNull();
    expect(validate).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(2);
  });

  test("rereads after an uncertain failed save without replaying the write", async () => {
    let reads = 0;
    const list = mock(async () => listResponse(reads++ === 0 ? [] : [saved]));
    const put = mock(async () => {
      throw new Error("connection closed");
    });
    const view = render(<PersonalProviderKeysSection credentialApi={api({
      listProviderCredentials: list,
      putProviderCredential: put,
    })} />);

    await view.findByRole("heading", { name: "Personal API keys" });
    fireEvent.click(view.getByRole("button", { name: "Add Anthropic key" }));
    await enterSecret(view.getByLabelText("New Anthropic API key"), "discard-after-request");
    fireEvent.click(view.getByRole("button", { name: "Save key" }));

    expect((await view.findByRole("alert")).textContent).toContain("could not confirm whether the key was saved");
    expect(list).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(1);
    expect(view.queryByDisplayValue("discard-after-request")).toBeNull();
    expect(view.queryByText(/revision 4/)).toBeNull();
    expect(view.getByRole("button", { name: "Replace OpenAI key" })).toBeTruthy();
  });

  test("rereads metadata after a revision conflict and never retries the write", async () => {
    const newer = { ...saved, revision: 5 };
    let reads = 0;
    const list = mock(async () => listResponse([reads++ === 0 ? saved : newer]));
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
    await enterSecret(view.getByLabelText("Replacement OpenAI API key"), "do-not-retain");
    fireEvent.click(view.getByRole("button", { name: "Replace key" }));

    expect((await view.findByRole("alert")).textContent).toContain("changed in another tab");
    expect(list).toHaveBeenCalledTimes(2);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(view.queryByDisplayValue("do-not-retain")).toBeNull();
    expect(view.queryByText(/revision 5/)).toBeNull();
    expect(view.getByRole("button", { name: "Replace OpenAI key" })).toBeTruthy();
  });
});
