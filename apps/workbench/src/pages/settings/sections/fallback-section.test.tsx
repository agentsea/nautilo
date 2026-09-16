import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const profileResponse = {
  viewerRole: "owner" as const,
  agent: {
    name: "Terra",
    fallback: { enabled: false, chain: [] as string[] },
  },
};

mock.module("../../../hooks/use-profile", () => ({
  useProfile: () => ({
    response: profileResponse,
  }),
}));

mock.module("../../../hooks/use-can", () => ({
  useCan: () => () => true,
}));

mock.module("../../../lib/api", () => ({
  apiClient: {
    getModels: async () => [
      {
        id: "openai:gpt-5.4-mini",
        displayName: "GPT-5.4 mini",
        provider: "openai",
        availability: "selectable",
      },
    ],
    resolveRetainedModels: async () => [],
    updateFallbackPolicy: async (fallback: { enabled: boolean; chain: string[] }) => fallback,
  },
}));

const { FallbackSection } = await import("./fallback-section");

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
});

describe("FallbackSection Agent scope", () => {
  test("labels its fallback policy as per-Agent and links capable users to Server Admin", async () => {
    const view = render(<MemoryRouter><FallbackSection /></MemoryRouter>);

    await waitFor(() => {
      expect(view.getByRole("heading", { name: "Model fallback (per-Agent)" })).toBeTruthy();
    });
    expect(view.getByText(/used only for this Agent/i)).toBeTruthy();
    expect(
      view
        .getByRole("link", { name: "Manage the server-wide baseline in Server Admin." })
        .getAttribute("href"),
    ).toBe("/admin#models");
  });
});
