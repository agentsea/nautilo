/**
 * M072 — Logto resource context defaults.
 *
 * Default `logtoResource` matches the workbench bootstrap fallback so
 * unit tests and SSR harnesses behave like production until a provider
 * overrides the audience.
 */
import { describe, test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useContext } from "react";
import { LogtoResourceContext, useLogtoResource } from "../../src/contexts/auth-mode";

function ProbeViaUseHook() {
  const cfg = useLogtoResource();
  return <span data-resource={cfg.logtoResource} />;
}

function ProbeViaUseContext() {
  const cfg = useContext(LogtoResourceContext);
  return <span data-resource={cfg.logtoResource} />;
}

describe("LogtoResourceContext (Logto resource)", () => {
  test("default logtoResource is the canonical API audience", () => {
    const html = renderToStaticMarkup(<ProbeViaUseHook />);
    expect(html).toContain('data-resource="https://api.nautilo.local"');
  });

  test("Provider value flows through useLogtoResource", () => {
    const html = renderToStaticMarkup(
      <LogtoResourceContext.Provider
        value={{ logtoResource: "https://api.x.test", logtoEndpoint: "" }}
      >
        <ProbeViaUseHook />
      </LogtoResourceContext.Provider>,
    );
    expect(html).toContain('data-resource="https://api.x.test"');
  });

  test("useContext direct read agrees with hook", () => {
    const html = renderToStaticMarkup(
      <LogtoResourceContext.Provider
        value={{ logtoResource: "https://api.y.test", logtoEndpoint: "" }}
      >
        <ProbeViaUseContext />
      </LogtoResourceContext.Provider>,
    );
    expect(html).toContain('data-resource="https://api.y.test"');
  });
});
