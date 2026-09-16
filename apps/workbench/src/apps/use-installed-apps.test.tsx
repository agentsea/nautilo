import { reapplyHappyDomGlobals } from "../../tests/bun-dom-preload";
import { render, renderHook, waitFor, act } from "@testing-library/react";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import type { ReactNode } from "react";
import type {
  ConditionalReadResult,
  ListMiniAppsResponse,
  PublicMiniAppDto,
} from "@nautilo/api-client/browser";
import { InstalledAppsProvider } from "./installed-apps-provider";

const sampleApps: PublicMiniAppDto[] = [
  {
    id: "sample-app",
    name: "Sample App",
    version: "0.1.0",
    status: "ready",
    sourceHash: "a".repeat(64),
    fileAssociations: {
      extensions: [".document.json"],
      mimeTypes: ["application/vnd.nautilo.document+json"],
    },
    canEditSource: false,
    description: null,
    installedAt: null,
    enabled: true,
  },
];

const viewerApps: PublicMiniAppDto[] = [
  {
    ...sampleApps[0]!,
    id: "viewer-b-app",
    name: "Viewer B App",
  },
];

let resolveList: ((value: { apps: PublicMiniAppDto[] }) => void) | undefined;
let rejectList: ((reason: unknown) => void) | undefined;
let pendingList = false;

const listMiniApps = mock((_options?: { ifNoneMatch?: string }) => {
  if (pendingList) {
    return new Promise<ConditionalReadResult<ListMiniAppsResponse>>((resolve, reject) => {
      resolveList = (value) =>
        resolve({
          status: 200,
          body: value,
          etag: 'W/"apps-v1"',
        });
      rejectList = reject;
    });
  }
  return Promise.resolve({
    status: 200 as const,
    body: { apps: sampleApps },
    etag: 'W/"apps-v1"',
  });
});

mock.module("../lib/api", () => ({
  apiClient: { listMiniAppsConditional: listMiniApps },
}));

let viewerGeneration = 1;
let credentialGeneration = 1;
let verified = true;

mock.module("../hooks/use-auth", () => ({
  useAuth: () => ({
    viewer: { isVerified: verified },
    viewerGeneration,
    credentialGeneration,
    session: { getAccessToken: async () => "token" },
  }),
}));

function TestProvider({ children }: { children: ReactNode }) {
  return <InstalledAppsProvider>{children}</InstalledAppsProvider>;
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  pendingList = false;
  resolveList = undefined;
  rejectList = undefined;
  viewerGeneration = 1;
  credentialGeneration = 1;
  verified = true;
  listMiniApps.mockClear();
});

describe("useInstalledApps", () => {
  let useInstalledApps: typeof import("./use-installed-apps").useInstalledApps;

  beforeAll(async () => {
    ({ useInstalledApps } = await import("./use-installed-apps"));
  });

  afterAll(() => {
    mock.restore();
    reapplyHappyDomGlobals();
  });

  function renderInstalledAppsHook() {
    return renderHook(() => useInstalledApps(), {
      wrapper: TestProvider,
    });
  }

  test("starts in loading state", async () => {
    pendingList = true;
    const { result } = renderInstalledAppsHook();
    expect(result.current).toEqual({ kind: "loading", reload: expect.any(Function) });
    resolveList?.({ apps: sampleApps });
    await waitFor(() => {
      expect(result.current.kind).toBe("ready");
    });
  });

  test("returns apps on success", async () => {
    const { result } = renderInstalledAppsHook();
    await waitFor(() => {
      expect(result.current).toEqual({
        kind: "ready",
        apps: sampleApps,
        reload: expect.any(Function),
      });
    });
    expect(listMiniApps).toHaveBeenCalledTimes(1);
  });

  test("shares one list request across multiple consumers", async () => {
    pendingList = true;
    const { result } = renderHook(
      () => ({
        first: useInstalledApps(),
        second: useInstalledApps(),
      }),
      { wrapper: TestProvider },
    );

    expect(listMiniApps).toHaveBeenCalledTimes(1);
    resolveList?.({ apps: sampleApps });
    await waitFor(() => {
      expect(result.current.first.kind).toBe("ready");
      expect(result.current.second.kind).toBe("ready");
    });
    expect(listMiniApps).toHaveBeenCalledTimes(1);
  });

  test("explicit reload performs one new request", async () => {
    const { result } = renderInstalledAppsHook();
    await waitFor(() => {
      expect(result.current.kind).toBe("ready");
    });
    expect(listMiniApps).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.reload();
    });
    await waitFor(() => {
      expect(listMiniApps).toHaveBeenCalledTimes(2);
    });
  });

  test("explicit reload sends the ETag and reuses apps on 304", async () => {
    const { result } = renderInstalledAppsHook();
    await waitFor(() => expect(result.current.kind).toBe("ready"));
    listMiniApps.mockImplementationOnce(async (options) => {
      expect(options).toEqual({ ifNoneMatch: 'W/"apps-v1"' });
      return { status: 304, etag: 'W/"apps-v1"' };
    });

    act(() => result.current.reload());

    await waitFor(() => {
      expect(result.current).toEqual({
        kind: "ready",
        apps: sampleApps,
        reload: expect.any(Function),
      });
    });
    expect(listMiniApps).toHaveBeenCalledTimes(2);
  });

  test("304 without a local list recovers with one unconditional request", async () => {
    listMiniApps.mockImplementationOnce(async () => ({
      status: 304,
      etag: 'W/"orphan"',
    }));

    const { result } = renderInstalledAppsHook();

    await waitFor(() => expect(result.current.kind).toBe("ready"));
    expect(result.current).toEqual({
      kind: "ready",
      apps: sampleApps,
      reload: expect.any(Function),
    });
    expect(listMiniApps).toHaveBeenCalledTimes(2);
    expect(listMiniApps.mock.calls[1]?.[0]).toBeUndefined();
  });

  test("viewer generation change clears stale apps and refetches", async () => {
    pendingList = true;
    const { result, rerender } = renderInstalledAppsHook();
    expect(result.current.kind).toBe("loading");

    resolveList?.({ apps: sampleApps });
    await waitFor(() => {
      expect(result.current.kind).toBe("ready");
      expect(result.current.apps).toEqual(sampleApps);
    });
    expect(listMiniApps).toHaveBeenCalledTimes(1);

    pendingList = true;
    viewerGeneration = 2;
    rerender();
    expect(result.current.kind).toBe("loading");
    expect("apps" in result.current).toBe(false);

    resolveList?.({ apps: viewerApps });
    await waitFor(() => {
      expect(result.current).toEqual({
        kind: "ready",
        apps: viewerApps,
        reload: expect.any(Function),
      });
    });
    expect(listMiniApps).toHaveBeenCalledTimes(2);
    expect(listMiniApps.mock.calls[1]?.[0]).toBeUndefined();
  });

  test("signout clears the list validator before the next verified load", async () => {
    const { result, rerender } = renderInstalledAppsHook();
    await waitFor(() => expect(result.current.kind).toBe("ready"));

    verified = false;
    rerender();
    expect(result.current.kind).toBe("loading");

    verified = true;
    rerender();
    await waitFor(() => expect(listMiniApps).toHaveBeenCalledTimes(2));
    expect(listMiniApps.mock.calls[1]?.[0]).toBeUndefined();
  });

  test("credential refresh alone does not refetch the app list", async () => {
    const { result, rerender } = renderInstalledAppsHook();
    await waitFor(() => {
      expect(result.current.kind).toBe("ready");
    });
    expect(listMiniApps).toHaveBeenCalledTimes(1);

    credentialGeneration = 2;
    rerender();

    await Promise.resolve();
    expect(listMiniApps).toHaveBeenCalledTimes(1);
    expect(result.current.kind).toBe("ready");
    expect(result.current.apps).toEqual(sampleApps);
  });

  test("keeps returned object identity stable across unrelated rerenders", async () => {
    const { result, rerender } = renderInstalledAppsHook();
    await waitFor(() => {
      expect(result.current.kind).toBe("ready");
    });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  test("retries transient network failures", async () => {
    listMiniApps.mockImplementationOnce(async () => {
      throw new Error("Network unavailable");
    });

    const { result } = renderInstalledAppsHook();
    await waitFor(() => {
      expect(result.current).toEqual({
        kind: "ready",
        apps: sampleApps,
        reload: expect.any(Function),
      });
    });
    expect(listMiniApps).toHaveBeenCalledTimes(2);
  });

  test("returns an error state when the API fails permanently", async () => {
    listMiniApps.mockImplementationOnce(async () => {
      throw new Error("Permission denied");
    });

    const { result } = renderInstalledAppsHook();
    await waitFor(() => {
      expect(result.current).toEqual({
        kind: "error",
        message: "Permission denied",
        reload: expect.any(Function),
      });
    });
  });

  test("uses a fallback error message for empty failures", async () => {
    listMiniApps.mockImplementationOnce(async () => {
      throw new Error("   ");
    });

    const { result } = renderInstalledAppsHook();
    await waitFor(() => {
      expect(result.current).toEqual({
        kind: "error",
        message: "Failed to load apps.",
        reload: expect.any(Function),
      });
    });
  });

  test("does not update state after unmount", async () => {
    pendingList = true;
    const states: Array<{ kind: string }> = [];

    function Harness() {
      states.push(useInstalledApps());
      return null;
    }

    const { unmount } = render(
      <TestProvider>
        <Harness />
      </TestProvider>,
    );
    expect(states.at(-1)).toEqual({ kind: "loading", reload: expect.any(Function) });

    unmount();
    resolveList?.({ apps: sampleApps });
    await Promise.resolve();
    await Promise.resolve();

    expect(states.every((state) => state.kind !== "ready")).toBe(true);
  });
});
