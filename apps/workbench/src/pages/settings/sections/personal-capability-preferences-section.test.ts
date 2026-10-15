import { act, createElement } from "react";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type {
  PersonalCapabilityPreferencesResponse,
  ReplacePersonalCapabilityPreferencesRequest,
} from "@nautilo/types";
import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";
import { PERSONAL_PROVIDER_CREDENTIALS_CHANGED_EVENT } from "../../../lib/caller-model-availability";

let viewerGeneration = 1;
mock.module("../../../hooks/use-auth", () => ({
  useAuth: () => ({ viewerGeneration, viewer: { isVerified: true } }),
}));

interface CapabilityApi {
  getPersonalCapabilityPreferences(): Promise<PersonalCapabilityPreferencesResponse>;
  replacePersonalCapabilityPreferences(
    input: ReplacePersonalCapabilityPreferencesRequest,
  ): Promise<PersonalCapabilityPreferencesResponse>;
}

function response(
  fundingSource: "personal" | "server",
  input: { revision?: number; selected?: boolean } = {},
): PersonalCapabilityPreferencesResponse {
  const modelId = "openrouter:model-a";
  const readiness = {
    status: "ready" as const,
    reason: null,
    fundingSource,
    providerRoute: "openrouter",
  };
  return {
    revision: input.revision ?? 0,
    overrides: input.selected ? { webSearchSynthesis: modelId } : {},
    fundingPreference: "personal_first",
    capabilities: [{
      role: "webSearchSynthesis",
      label: "Web search synthesis",
      description: "Summarizes search results.",
      selection: {
        source: input.selected ? "personal" : "inherited",
        modelId,
        displayName: "Model A",
      },
      readiness,
      options: [{
        modelId,
        displayName: "Model A",
        provider: "openrouter",
        readiness,
      }],
    }],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const getPersonalCapabilityPreferences = mock<CapabilityApi["getPersonalCapabilityPreferences"]>(
  async () => response("server"),
);
const replacePersonalCapabilityPreferences = mock<CapabilityApi["replacePersonalCapabilityPreferences"]>(
  async () => response("personal", { revision: 1 }),
);
mock.module("../../../lib/api", () => ({
  apiClient: { getPersonalCapabilityPreferences, replacePersonalCapabilityPreferences },
}));

const { PersonalCapabilityPreferencesSection, nextPersonalCapabilityOverrides } =
  await import("./personal-capability-preferences-section");

function renderSection() {
  return render(createElement(
    MemoryRouter,
    null,
    createElement(PersonalCapabilityPreferencesSection),
  ));
}

function credentialChanged(): void {
  window.dispatchEvent(new Event(PERSONAL_PROVIDER_CREDENTIALS_CHANGED_EVENT));
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  viewerGeneration = 1;
  getPersonalCapabilityPreferences.mockReset();
  getPersonalCapabilityPreferences.mockImplementation(async () => response("server"));
  replacePersonalCapabilityPreferences.mockReset();
  replacePersonalCapabilityPreferences.mockImplementation(
    async () => response("personal", { revision: 1 }),
  );
});

describe("personal capability preference editing", () => {
  test("describes eligible personal Memory choices without merging Genie or Room settings", async () => {
    const view = renderSection();
    expect(await view.findByText(/image understanding/)).toBeTruthy();
    expect(await view.findByText(/eligible personal Memory processing/)).toBeTruthy();
    expect(view.getByText(/Genie and Room model settings remain separate/)).toBeTruthy();
  });

  test("changes one role without copying inherited defaults", () => {
    expect(nextPersonalCapabilityOverrides(
      { decision: "typesafe:jev-1.13.0" },
      "webSearchSynthesis",
      "openrouter:model-a",
    )).toEqual({
      decision: "typesafe:jev-1.13.0",
      webSearchSynthesis: "openrouter:model-a",
    });
  });

  test("reset removes the explicit role instead of writing an effective default", () => {
    expect(nextPersonalCapabilityOverrides({
      decision: "typesafe:jev-1.13.0",
      webSearchSynthesis: "openrouter:model-a",
    }, "webSearchSynthesis", null)).toEqual({
      decision: "typesafe:jev-1.13.0",
    });
  });

  test("renders and resets the projected image understanding role independently", async () => {
    const projected = response("server");
    projected.overrides = { imageUnderstanding: "openai:gpt-5.4-mini" };
    projected.capabilities = [{
      role: "imageUnderstanding",
      label: "Image understanding",
      description: "Reads and reasons about attached images without generating new ones.",
      selection: { source: "personal", modelId: "openai:gpt-5.4-mini", displayName: "GPT-5.4 mini" },
      readiness: { status: "ready", reason: null, fundingSource: "server", providerRoute: "openai" },
      options: [{
        modelId: "openai:gpt-5.4-mini",
        displayName: "GPT-5.4 mini",
        provider: "openai",
        readiness: { status: "ready", reason: null, fundingSource: "server", providerRoute: "openai" },
      }],
    }];
    getPersonalCapabilityPreferences.mockResolvedValueOnce(projected);
    replacePersonalCapabilityPreferences.mockResolvedValueOnce({
      ...projected,
      revision: 1,
      overrides: {},
      capabilities: [{
        ...projected.capabilities[0]!,
        selection: { source: "inherited", modelId: "openai:gpt-5.4-mini", displayName: "GPT-5.4 mini" },
      }],
    });
    const view = renderSection();
    const select = await view.findByLabelText("Image understanding") as HTMLSelectElement;

    expect(view.getByText(/without generating new ones/)).toBeTruthy();
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() => expect(replacePersonalCapabilityPreferences).toHaveBeenCalledWith({
      expectedRevision: 0,
      overrides: {},
    }));
  });
});

describe("personal capability funding refresh", () => {
  test("refreshes server funding to personal funding after a credential change", async () => {
    getPersonalCapabilityPreferences
      .mockResolvedValueOnce(response("server"))
      .mockResolvedValue(response("personal"));
    const view = renderSection();

    expect(await view.findByRole("option", { name: /Server openrouter credential/ })).toBeTruthy();
    act(credentialChanged);

    expect(await view.findByRole("option", { name: /Your openrouter credential/ })).toBeTruthy();
    expect(getPersonalCapabilityPreferences).toHaveBeenCalledTimes(2);
  });

  test("refreshes personal funding to server funding after credential deletion", async () => {
    getPersonalCapabilityPreferences
      .mockResolvedValueOnce(response("personal"))
      .mockResolvedValue(response("server"));
    const view = renderSection();

    expect(await view.findByRole("option", { name: /Your openrouter credential/ })).toBeTruthy();
    act(credentialChanged);

    expect(await view.findByRole("option", { name: /Server openrouter credential/ })).toBeTruthy();
    expect(getPersonalCapabilityPreferences).toHaveBeenCalledTimes(2);
  });

  test("queues a fresh read after each in-flight burst instead of retaining coalesced stale funding", async () => {
    const first = deferred<PersonalCapabilityPreferencesResponse>();
    const second = deferred<PersonalCapabilityPreferencesResponse>();
    const third = deferred<PersonalCapabilityPreferencesResponse>();
    getPersonalCapabilityPreferences
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementationOnce(() => third.promise);
    const view = renderSection();
    await waitFor(() => expect(getPersonalCapabilityPreferences).toHaveBeenCalledTimes(1));

    act(() => {
      credentialChanged();
      credentialChanged();
    });
    await act(async () => first.resolve(response("server")));
    await waitFor(() => expect(getPersonalCapabilityPreferences).toHaveBeenCalledTimes(2));

    act(() => {
      credentialChanged();
      credentialChanged();
    });
    await act(async () => second.resolve(response("server")));
    await waitFor(() => expect(getPersonalCapabilityPreferences).toHaveBeenCalledTimes(3));
    await act(async () => third.resolve(response("personal")));

    expect(await view.findByRole("option", { name: /Your openrouter credential/ })).toBeTruthy();
    expect(getPersonalCapabilityPreferences).toHaveBeenCalledTimes(3);
  });

  test("does not let an older refresh replace a newer preference mutation", async () => {
    const staleRefresh = deferred<PersonalCapabilityPreferencesResponse>();
    const save = deferred<PersonalCapabilityPreferencesResponse>();
    getPersonalCapabilityPreferences
      .mockResolvedValueOnce(response("server"))
      .mockImplementationOnce(() => staleRefresh.promise);
    replacePersonalCapabilityPreferences.mockImplementationOnce(() => save.promise);
    const view = renderSection();
    const selector = await view.findByLabelText("Web search synthesis") as HTMLSelectElement;

    act(credentialChanged);
    await waitFor(() => expect(getPersonalCapabilityPreferences).toHaveBeenCalledTimes(2));
    fireEvent.change(selector, { target: { value: "openrouter:model-a" } });
    await waitFor(() => expect(replacePersonalCapabilityPreferences).toHaveBeenCalledWith({
      expectedRevision: 0,
      overrides: { webSearchSynthesis: "openrouter:model-a" },
    }));
    await act(async () => save.resolve(response("personal", { revision: 1, selected: true })));
    await act(async () => staleRefresh.resolve(response("server")));

    await waitFor(() => expect(selector.value).toBe("openrouter:model-a"));
    expect(view.getByText(/Your choice · Your openrouter credential/)).toBeTruthy();
    expect(getPersonalCapabilityPreferences).toHaveBeenCalledTimes(2);
  });

  test("rereads readiness after a credential event overlaps a preference save", async () => {
    const overlappedRefresh = deferred<PersonalCapabilityPreferencesResponse>();
    const save = deferred<PersonalCapabilityPreferencesResponse>();
    getPersonalCapabilityPreferences
      .mockResolvedValueOnce(response("server"))
      .mockImplementationOnce(() => overlappedRefresh.promise)
      .mockResolvedValueOnce(response("personal", { revision: 1, selected: true }));
    replacePersonalCapabilityPreferences.mockImplementationOnce(() => save.promise);
    const view = renderSection();
    const selector = await view.findByLabelText("Web search synthesis") as HTMLSelectElement;

    fireEvent.change(selector, { target: { value: "openrouter:model-a" } });
    await waitFor(() => expect(replacePersonalCapabilityPreferences).toHaveBeenCalledTimes(1));
    act(credentialChanged);
    await waitFor(() => expect(getPersonalCapabilityPreferences).toHaveBeenCalledTimes(2));
    await act(async () => overlappedRefresh.resolve(response("personal")));
    expect(await view.findByRole("option", { name: /Your openrouter credential/ })).toBeTruthy();

    await act(async () => save.resolve(response("server", { revision: 1, selected: true })));
    await waitFor(() => expect(getPersonalCapabilityPreferences).toHaveBeenCalledTimes(3));

    expect(selector.value).toBe("openrouter:model-a");
    expect(view.getByText(/Your choice · Your openrouter credential/)).toBeTruthy();
  });

  test("queues the post-save reread behind a credential refresh that is still pending", async () => {
    const pendingRefresh = deferred<PersonalCapabilityPreferencesResponse>();
    const save = deferred<PersonalCapabilityPreferencesResponse>();
    getPersonalCapabilityPreferences
      .mockResolvedValueOnce(response("server"))
      .mockImplementationOnce(() => pendingRefresh.promise)
      .mockResolvedValueOnce(response("personal", { revision: 1, selected: true }));
    replacePersonalCapabilityPreferences.mockImplementationOnce(() => save.promise);
    const view = renderSection();
    const selector = await view.findByLabelText("Web search synthesis") as HTMLSelectElement;

    fireEvent.change(selector, { target: { value: "openrouter:model-a" } });
    act(credentialChanged);
    await waitFor(() => expect(getPersonalCapabilityPreferences).toHaveBeenCalledTimes(2));
    await act(async () => save.resolve(response("server", { revision: 1, selected: true })));
    await act(async () => pendingRefresh.resolve(response("personal")));
    await waitFor(() => expect(getPersonalCapabilityPreferences).toHaveBeenCalledTimes(3));

    expect(selector.value).toBe("openrouter:model-a");
    expect(view.getByText(/Your choice · Your openrouter credential/)).toBeTruthy();
  });

  test("does not reread readiness after an ordinary preference save", async () => {
    replacePersonalCapabilityPreferences.mockResolvedValueOnce(
      response("personal", { revision: 1, selected: true }),
    );
    const view = renderSection();
    const selector = await view.findByLabelText("Web search synthesis") as HTMLSelectElement;

    fireEvent.change(selector, { target: { value: "openrouter:model-a" } });
    await waitFor(() => expect(selector.value).toBe("openrouter:model-a"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(getPersonalCapabilityPreferences).toHaveBeenCalledTimes(1);
    expect(view.getByText(/Your choice · Your openrouter credential/)).toBeTruthy();
  });

  test("does not accept a response started for an earlier account generation", async () => {
    const priorAccount = deferred<PersonalCapabilityPreferencesResponse>();
    const currentAccount = deferred<PersonalCapabilityPreferencesResponse>();
    getPersonalCapabilityPreferences
      .mockImplementationOnce(() => priorAccount.promise)
      .mockImplementationOnce(() => currentAccount.promise);
    const view = renderSection();
    await waitFor(() => expect(getPersonalCapabilityPreferences).toHaveBeenCalledTimes(1));

    viewerGeneration = 2;
    view.rerender(createElement(
      MemoryRouter,
      null,
      createElement(PersonalCapabilityPreferencesSection),
    ));
    await waitFor(() => expect(getPersonalCapabilityPreferences).toHaveBeenCalledTimes(2));
    await act(async () => currentAccount.resolve(response("personal")));
    await act(async () => priorAccount.resolve(response("server")));

    expect(await view.findByRole("option", { name: /Your openrouter credential/ })).toBeTruthy();
    expect(view.queryByRole("option", { name: /Server openrouter credential/ })).toBeNull();
  });

  test("removes the credential listener when the section unmounts", async () => {
    const view = renderSection();
    await view.findByRole("option", { name: /Server openrouter credential/ });
    view.unmount();

    act(credentialChanged);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(getPersonalCapabilityPreferences).toHaveBeenCalledTimes(1);
  });
});
