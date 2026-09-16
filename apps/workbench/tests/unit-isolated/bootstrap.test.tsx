import "../bun-dom-preload";
import { act, isValidElement } from "react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { createRoot, type Root } from "react-dom/client";
import { useBlocker, useNavigate } from "react-router-dom";

let appRenderer: () => ReactNode = () => (
  <div data-testid="workbench-app">protected workbench</div>
);

mock.module("../../src/app", () => ({
  App: () => appRenderer(),
}));

mock.module("@logto/react", () => ({
  LogtoProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Prompt: { Login: "login", Consent: "consent" },
  useLogto: () => ({ isAuthenticated: false, isLoading: false }),
}));

mock.module("../../src/lib/nautilo-logto-browser-client", () => ({
  NautiloWorkbenchLogtoClient: class {},
}));

const { startWorkbenchBootstrap } = await import("../../src/bootstrap");

type Health = Awaited<ReturnType<typeof import("../../src/lib/api").apiClient.getHealth>>;

let roots: Root[] = [];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  act(() => {
    for (const root of roots) root.unmount();
  });
  roots = [];
  document.body.replaceChildren();
  appRenderer = () => <div data-testid="workbench-app">protected workbench</div>;
  window.history.replaceState(null, "", "/");
});

function NavigationBlockerProbe() {
  const navigate = useNavigate();
  const blocker = useBlocker(true);
  return (
    <div>
      <span data-testid="blocker-state">{blocker.state}</span>
      <button data-testid="navigate-next" onClick={() => void navigate("/next")}>Next</button>
      <button data-testid="navigate-back" onClick={() => void navigate(-1)}>Back</button>
      {blocker.state === "blocked" ? (
        <>
          <button data-testid="proceed" onClick={() => blocker.proceed()}>Proceed</button>
          <button data-testid="reset" onClick={() => blocker.reset()}>Cancel</button>
        </>
      ) : null}
    </div>
  );
}

function rootHarness(onReadyRouter?: (router: { dispose(): void }) => void) {
  let rootCreations = 0;
  return {
    createRoot: ((element: Element | DocumentFragment) => {
      rootCreations += 1;
      const root = createRoot(element);
      const wrappedRoot: Root = {
        render(children) {
          if (isValidElement<{ router?: { dispose(): void } }>(children) && children.props.router) {
            onReadyRouter?.(children.props.router);
          }
          root.render(children);
        },
        unmount() {
          root.unmount();
        },
      };
      roots.push(wrappedRoot);
      return wrappedRoot;
    }) as typeof createRoot,
    rootCreations: () => rootCreations,
  };
}

function validHealth(): Health {
  return {
    logtoEndpoint: "https://logto.example.test",
    logtoWorkbenchAppId: "workbench-app-id",
    logtoResource: "https://api.example.test",
    serverUrl: "https://server.example.test",
    workbenchUrl: "https://workbench.example.test",
  } as Health;
}

function mountPoint(): HTMLElement {
  const element = document.createElement("div");
  document.body.append(element);
  return element;
}

describe("workbench bootstrap", () => {
  test("does not capture owner claims, create a root, or call health after the exact-root selector redirects", async () => {
    const harness = rootHarness();
    let ownerClaimCaptureObserved = false;
    let healthCalled = false;
    window.history.replaceState(null, "", "/claim#claim=inv_not-used");
    await startWorkbenchBootstrap({
      rootElement: mountPoint(),
      createRoot: harness.createRoot,
      interfaceEntry: () => {
        ownerClaimCaptureObserved = sessionStorage.getItem("nautilo.ownerClaimHandoff.v1") !== null;
        return true;
      },
      getHealth: async () => {
        healthCalled = true;
        return validHealth();
      },
    });
    expect(ownerClaimCaptureObserved).toBe(false);
    expect(harness.rootCreations()).toBe(0);
    expect(healthCalled).toBe(false);
    window.history.replaceState(null, "", "/");
  });

  test("scrubs a `/claim` fragment into session custody before React or health work", async () => {
    const claim = `inv_${"a".repeat(32)}`;
    window.history.replaceState(null, "", `/claim#claim=${claim}`);
    const harness = rootHarness();
    let healthObservedScrubbedClaim = false;

    await act(async () => {
      await startWorkbenchBootstrap({
        rootElement: mountPoint(),
        createRoot: harness.createRoot,
        getHealth: async () => {
          healthObservedScrubbedClaim = window.location.hash === ""
            && sessionStorage.getItem("nautilo.ownerClaimHandoff.v1")?.includes(claim) === true;
          return validHealth();
        },
      });
    });

    expect(healthObservedScrubbedClaim).toBe(true);
    expect(window.location.hash).toBe("");
    window.history.replaceState(null, "", "/");
    sessionStorage.removeItem("nautilo.ownerClaimHandoff.v1");
  });

  test("commits the non-privileged frame before a never-resolving health check", () => {
    const pendingHealth = new Promise<Health>(() => {});
    const harness = rootHarness();

    act(() => {
      void startWorkbenchBootstrap({
        rootElement: mountPoint(),
        createRoot: harness.createRoot,
        getHealth: () => pendingHealth,
      });
    });

    expect(document.querySelector('[data-testid="workbench-bootstrap-frame"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="workbench-app"]')).toBeNull();
    expect(harness.rootCreations()).toBe(1);
  });

  test("refines the same root to the existing app after delayed valid health", async () => {
    let resolveHealth: (health: Health) => void = () => {};
    const pendingHealth = new Promise<Health>((resolve) => {
      resolveHealth = resolve;
    });
    const harness = rootHarness();
    let bootstrap: Promise<void> = Promise.resolve();

    act(() => {
      bootstrap = startWorkbenchBootstrap({
        rootElement: mountPoint(),
        createRoot: harness.createRoot,
        getHealth: () => pendingHealth,
      });
    });
    expect(document.querySelector('[data-testid="workbench-bootstrap-frame"]')).not.toBeNull();

    await act(async () => {
      resolveHealth(validHealth());
      await bootstrap;
    });

    expect(document.querySelector('[data-testid="workbench-app"]')).not.toBeNull();
    expect(harness.rootCreations()).toBe(1);
  });

  test("uses the supported data-router blocker for push and back transitions", async () => {
    appRenderer = () => <NavigationBlockerProbe />;
    let routerDisposeCalls = 0;
    const harness = rootHarness((router) => {
      const dispose = router.dispose.bind(router);
      router.dispose = () => {
        routerDisposeCalls += 1;
        dispose();
      };
    });
    await act(async () => {
      await startWorkbenchBootstrap({
        rootElement: mountPoint(),
        createRoot: harness.createRoot,
        getHealth: async () => validHealth(),
      });
    });
    expect(routerDisposeCalls).toBe(0);

    await act(async () => {
      document.querySelector<HTMLElement>('[data-testid="navigate-next"]')?.click();
    });
    expect(window.location.pathname).toBe("/");
    expect(document.querySelector('[data-testid="blocker-state"]')?.textContent).toBe("blocked");

    await act(async () => {
      document.querySelector<HTMLElement>('[data-testid="reset"]')?.click();
    });
    expect(window.location.pathname).toBe("/");

    await act(async () => {
      document.querySelector<HTMLElement>('[data-testid="navigate-next"]')?.click();
    });
    await act(async () => {
      document.querySelector<HTMLElement>('[data-testid="proceed"]')?.click();
    });
    expect(window.location.pathname).toBe("/next");

    await act(async () => {
      document.querySelector<HTMLElement>('[data-testid="navigate-back"]')?.click();
    });
    expect(window.location.pathname).toBe("/next");
    expect(document.querySelector('[data-testid="blocker-state"]')?.textContent).toBe("blocked");
    await act(async () => {
      document.querySelector<HTMLElement>('[data-testid="proceed"]')?.click();
    });
    expect(window.location.pathname).toBe("/");

    const [root] = roots.splice(0, 1);
    act(() => root?.unmount());
    expect(routerDisposeCalls).toBe(1);
  });

  test("fails closed when health omits Logto configuration", async () => {
    const harness = rootHarness();
    let bootstrap: Promise<void> = Promise.resolve();

    act(() => {
      bootstrap = startWorkbenchBootstrap({
        rootElement: mountPoint(),
        createRoot: harness.createRoot,
        getHealth: async () => ({}) as Health,
      });
    });
    await act(async () => {
      await bootstrap;
    });

    expect(document.body.textContent).toContain("Cannot start workbench");
    expect(document.body.textContent).toContain("missing Logto configuration");
    expect(document.body.textContent).toContain("reload this page");
  });

  test("fails closed when the health request throws", async () => {
    const harness = rootHarness();
    let bootstrap: Promise<void> = Promise.resolve();

    act(() => {
      bootstrap = startWorkbenchBootstrap({
        rootElement: mountPoint(),
        createRoot: harness.createRoot,
        getHealth: async () => {
          throw new Error("offline");
        },
      });
    });
    await act(async () => {
      await bootstrap;
    });

    expect(document.body.textContent).toContain("Could not reach the server: offline");
  });
});
