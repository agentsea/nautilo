import { describe, it, expect } from "bun:test";
import {
  agentBrowserArgv,
  agentBrowserSnapshotJsonArgv,
  agentBrowserMouseClickArgvs,
  agentBrowserScrollArgvs,
  agentBrowserViewportEvalArgv,
  browserImageCoordsToCss,
  BROWSER_EMPTY_DOM_TEXT_HINT,
  agentBrowserCdpArgv,
  browserCdpArgvPrefix,
  browserArgvPrefix,
  browserToolMayMutate,
  isBrowserTool,
  BROWSER_TOOLS,
} from "./browser";

describe(" agentBrowserArgv — argv mapping", () => {
  const cfgPath = "/tmp/agent-browser-provider.json";
  const session = "nautilo-default";

  const prefix = [
    "--config",
    cfgPath,
    "--provider",
    "nautilo-browser",
    "--session",
    session,
  ];

  it("browser_snapshot maps to agent-browser snapshot with provider config", () => {
    expect(agentBrowserArgv("browser_snapshot", {}, cfgPath, session)).toEqual([
      ...prefix,
      "snapshot",
    ]);
  });

  it("browser_snapshot JSON helper requests a structured snapshot envelope", () => {
    expect(agentBrowserSnapshotJsonArgv(cfgPath, session)).toEqual([
      ...prefix,
      "--json",
      "snapshot",
    ]);
  });

  it("browser_click maps ref to click verb", () => {
    expect(
      agentBrowserArgv("browser_click", { ref: "@e3" }, cfgPath, session),
    ).toEqual([...prefix, "click", "@e3"]);
  });

  it("normalizes bare snapshot refs to agent-browser @refs", () => {
    expect(agentBrowserArgv("browser_click", { ref: "e148" }, cfgPath, session)).toEqual([
      ...prefix,
      "click",
      "@e148",
    ]);
    expect(
      agentBrowserArgv("browser_type", { ref: "e148", text: "search" }, cfgPath, session),
    ).toEqual([...prefix, "type", "@e148", "search"]);
    expect(agentBrowserArgv("browser_read", { ref: "e148" }, cfgPath, session)).toEqual([
      ...prefix,
      "get",
      "text",
      "@e148",
    ]);
    expect(agentBrowserArgv("browser_get", { what: "box", ref: "e148" }, cfgPath, session)).toEqual([
      ...prefix,
      "get",
      "box",
      "@e148",
    ]);
  });

  it("browser_type maps to type by default (append, no clear)", () => {
    expect(
      agentBrowserArgv(
        "browser_type",
        { ref: "@e5", text: "hello" },
        cfgPath,
        session,
      ),
    ).toEqual([...prefix, "type", "@e5", "hello"]);
  });

  it("browser_type maps to fill when clear is true", () => {
    expect(
      agentBrowserArgv(
        "browser_type",
        { ref: "@e5", text: "hello", clear: true },
        cfgPath,
        session,
      ),
    ).toEqual([...prefix, "fill", "@e5", "hello"]);
  });

  it("browser_type maps to type when clear is false", () => {
    expect(
      agentBrowserArgv(
        "browser_type",
        { ref: "@e5", text: "hello", clear: false },
        cfgPath,
        session,
      ),
    ).toEqual([...prefix, "type", "@e5", "hello"]);
  });

  it("browser_press maps key to press verb", () => {
    expect(
      agentBrowserArgv("browser_press", { key: "Enter" }, cfgPath, session),
    ).toEqual([...prefix, "press", "Enter"]);

    expect(
      agentBrowserArgv(
        "browser_press",
        { key: "Control+a" },
        cfgPath,
        session,
      ),
    ).toEqual([...prefix, "press", "Control+a"]);
  });

  it("browser_press focuses a current ref and presses in one fail-closed batch", () => {
    expect(
      agentBrowserArgv(
        "browser_press",
        { ref: "e12", key: "Enter" },
        cfgPath,
        session,
      ),
    ).toEqual([
      ...prefix,
      "--json",
      "batch",
      "--bail",
      "focus '@e12'",
      "press 'Enter'",
    ]);
  });

  it("quotes targeted browser_press values so they cannot add batch commands", () => {
    expect(
      agentBrowserArgv(
        "browser_press",
        { ref: "@e12", key: "Enter' 'click @e99" },
        cfgPath,
        session,
      ),
    ).toEqual([
      ...prefix,
      "--json",
      "batch",
      "--bail",
      "focus '@e12'",
      "press 'Enter'\"'\"' '\"'\"'click @e99'",
    ]);
  });

  it("browser_back maps to the native agent-browser history verb", () => {
    expect(agentBrowserArgv("browser_back", {}, cfgPath, session)).toEqual([
      ...prefix,
      "back",
    ]);
  });

  it("browser_open maps an HTTP(S) URL to native navigation", () => {
    expect(
      agentBrowserArgv("browser_open", { url: "https://example.com/path?q=1" }, cfgPath, session),
    ).toEqual([...prefix, "open", "https://example.com/path?q=1"]);
    expect(
      agentBrowserArgv("browser_open", { url: "http://localhost:7001" }, cfgPath, session),
    ).toEqual([...prefix, "open", "http://localhost:7001"]);
  });

  it("browser_open rejects missing, relative, and non-web URLs", () => {
    expect(() => agentBrowserArgv("browser_open", {}, cfgPath, session)).toThrow(
      /non-empty string `url`/,
    );
    expect(() =>
      agentBrowserArgv("browser_open", { url: "/relative" }, cfgPath, session),
    ).toThrow(/absolute HTTP or HTTPS/);
    expect(() =>
      agentBrowserArgv("browser_open", { url: "file:///etc/passwd" }, cfgPath, session),
    ).toThrow(/absolute HTTP or HTTPS/);
  });

  it("maps native navigation and pointer controls", () => {
    expect(agentBrowserArgv("browser_forward", {}, cfgPath, session)).toEqual([
      ...prefix,
      "forward",
    ]);
    expect(agentBrowserArgv("browser_reload", {}, cfgPath, session)).toEqual([
      ...prefix,
      "reload",
    ]);
    expect(agentBrowserArgv("browser_hover", { ref: "e3" }, cfgPath, session)).toEqual([
      ...prefix,
      "hover",
      "@e3",
    ]);
    expect(
      agentBrowserArgv("browser_double_click", { ref: "@e4" }, cfgPath, session),
    ).toEqual([...prefix, "dblclick", "@e4"]);
    expect(
      agentBrowserArgv("browser_drag", { from: "e5", to: "@e6" }, cfgPath, session),
    ).toEqual([...prefix, "drag", "@e5", "@e6"]);
    expect(
      agentBrowserArgv(
        "browser_drag",
        { from: "#drag-source", to: "#drop-zone" },
        cfgPath,
        session,
      ),
    ).toEqual([...prefix, "drag", "#drag-source", "#drop-zone"]);
  });

  it("maps native form, element-scroll, and wait controls", () => {
    expect(
      agentBrowserArgv(
        "browser_select",
        { ref: "e7", values: ["one", "two"] },
        cfgPath,
        session,
      ),
    ).toEqual([...prefix, "select", "@e7", "one", "two"]);
    expect(
      agentBrowserArgv(
        "browser_set_checked",
        { ref: "e8", checked: true },
        cfgPath,
        session,
      ),
    ).toEqual([...prefix, "check", "@e8"]);
    expect(
      agentBrowserArgv(
        "browser_set_checked",
        { ref: "e8", checked: false },
        cfgPath,
        session,
      ),
    ).toEqual([...prefix, "uncheck", "@e8"]);
    expect(
      agentBrowserArgv("browser_scroll_into_view", { ref: "e9" }, cfgPath, session),
    ).toEqual([...prefix, "scrollintoview", "@e9"]);
    expect(agentBrowserArgv("browser_wait", { ref: "e10" }, cfgPath, session)).toEqual([
      ...prefix,
      "is",
      "visible",
      "@e10",
    ]);
    expect(
      agentBrowserArgv("browser_wait", { milliseconds: 250 }, cfgPath, session),
    ).toEqual([...prefix, "wait", "250"]);
  });

  it("rejects malformed native form and wait controls", () => {
    expect(() =>
      agentBrowserArgv("browser_select", { ref: "e1", values: [] }, cfgPath, session),
    ).toThrow(/non-empty string array/);
    expect(() =>
      agentBrowserArgv(
        "browser_set_checked",
        { ref: "e1", checked: "yes" },
        cfgPath,
        session,
      ),
    ).toThrow(/boolean/);
    expect(() => agentBrowserArgv("browser_wait", {}, cfgPath, session)).toThrow(/exactly one/);
    expect(() =>
      agentBrowserArgv(
        "browser_wait",
        { ref: "e1", milliseconds: 10 },
        cfgPath,
        session,
      ),
    ).toThrow(/exactly one/);
    expect(() =>
      agentBrowserArgv("browser_wait", { milliseconds: 30_001 }, cfgPath, session),
    ).toThrow(/exactly one/);
  });

  it("browser_read maps ref to get text verb", () => {
    expect(
      agentBrowserArgv("browser_read", { ref: "@e7" }, cfgPath, session),
    ).toEqual([...prefix, "get", "text", "@e7"]);
    expect(
      agentBrowserArgv("browser_read", { ref: "#status" }, cfgPath, session),
    ).toEqual([...prefix, "get", "text", "#status"]);
  });

  it("preserves selector-scoped upstream get text/html argv behavior", () => {
    // Upstream parses both `get text` and `get html` with a required selector;
    // `browser_read` is its text-only element wrapper, not a whole-page reader.
    expect(agentBrowserArgv("browser_read", { ref: "body" }, cfgPath, session)).toEqual([
      ...prefix,
      "get",
      "text",
      "body",
    ]);
    expect(agentBrowserArgv("browser_get", { what: "html", ref: "main" }, cfgPath, session)).toEqual([
      ...prefix,
      "get",
      "html",
      "main",
    ]);
    // Preserve the historical relay mapping: it permits omission even though
    // native agent-browser will subsequently reject selector-less `get html`.
    expect(agentBrowserArgv("browser_get", { what: "html" }, cfgPath, session)).toEqual([
      ...prefix,
      "get",
      "html",
    ]);
  });

  it("browser_screenshot maps to screenshot with capture path", () => {
    expect(
      agentBrowserArgv(
        "browser_screenshot",
        { _capturePath: "/tmp/nautilo-browser-shot-1.png" },
        cfgPath,
        session,
      ),
    ).toEqual([...prefix, "screenshot", "/tmp/nautilo-browser-shot-1.png"]);
  });

  it("browser_get maps what/ref/name to get verb", () => {
    expect(
      agentBrowserArgv("browser_get", { what: "box", ref: "@e2" }, cfgPath, session),
    ).toEqual([...prefix, "get", "box", "@e2"]);

    expect(
      agentBrowserArgv(
        "browser_get",
        { what: "attr", ref: "@e4", name: "href" },
        cfgPath,
        session,
      ),
    ).toEqual([...prefix, "get", "attr", "@e4", "href"]);

    expect(agentBrowserArgv("browser_get", { what: "title" }, cfgPath, session)).toEqual([
      ...prefix,
      "get",
      "title",
    ]);

    expect(agentBrowserArgv("browser_get", { what: "url" }, cfgPath, session)).toEqual([
      ...prefix,
      "get",
      "url",
    ]);
  });

  it("browser_scroll is handled separately — agentBrowserArgv throws", () => {
    expect(() =>
      agentBrowserArgv("browser_scroll", { direction: "down" }, cfgPath, session),
    ).toThrow(/Unknown browser tool: browser_scroll/);

    expect(() =>
      agentBrowserArgv(
        "browser_scroll",
        { direction: "up", amount: 400 },
        cfgPath,
        session,
      ),
    ).toThrow(/Unknown browser tool: browser_scroll/);
  });

  it("agentBrowserScrollArgvs — down/up wheel at center; left/right legacy scroll", () => {
    expect(agentBrowserScrollArgvs(cfgPath, session, "down", 600, 400, 300)).toEqual([
      [...prefix, "mouse", "move", "400", "300"],
      [...prefix, "mouse", "wheel", "600"],
    ]);

    expect(agentBrowserScrollArgvs(cfgPath, session, "up", 400, 200, 150)).toEqual([
      [...prefix, "mouse", "move", "200", "150"],
      [...prefix, "mouse", "wheel", "-400"],
    ]);

    expect(agentBrowserScrollArgvs(cfgPath, session, "left", 300, 400, 300)).toEqual([
      [...prefix, "scroll", "left", "300"],
    ]);

    expect(agentBrowserScrollArgvs(cfgPath, session, "right", 250, 400, 300)).toEqual([
      [...prefix, "scroll", "right", "250"],
    ]);
  });

  it("browserViewportEvalArgv returns an object, not double-encoded JSON", () => {
    expect(agentBrowserViewportEvalArgv(cfgPath, session)).toEqual([
      ...prefix,
      "eval",
      "({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})",
    ]);
  });

  it("browserImageCoordsToCss divides by scale with rounding", () => {
    expect(browserImageCoordsToCss(480, 720, 2.4)).toEqual({ cssX: 200, cssY: 300 });
    expect(browserImageCoordsToCss(100, 100, 0)).toEqual({ cssX: 100, cssY: 100 });
  });

  it("BROWSER_EMPTY_DOM_TEXT_HINT mentions screenshot and mouse", () => {
    expect(BROWSER_EMPTY_DOM_TEXT_HINT).toContain("browser_screenshot");
    expect(BROWSER_EMPTY_DOM_TEXT_HINT).toContain("browser_mouse");
  });

  it("browser_mouse click uses move/down/up argv sequence", () => {
    expect(agentBrowserMouseClickArgvs(cfgPath, session, 120, 340)).toEqual([
      [...prefix, "mouse", "move", "120", "340"],
      [...prefix, "mouse", "down", "left"],
      [...prefix, "mouse", "up", "left"],
    ]);
  });

  it("browserArgvPrefix matches BROWSER_PREFIX tokens", () => {
    expect([...browserArgvPrefix(cfgPath, session)]).toEqual([...prefix]);
  });

  it("builds direct-CDP argv without a provider, config, or CDP bearer capability", () => {
    expect(browserCdpArgvPrefix("connected-operation-epoch")).toEqual([
      "--session",
      "connected-operation-epoch",
    ]);
    expect(agentBrowserCdpArgv(
      "browser_click",
      { ref: "e12" },
      "connected-operation-epoch",
    )).toEqual([
      "--session",
      "connected-operation-epoch",
      "click",
      "@e12",
    ]);
    const argv = agentBrowserCdpArgv(
      "browser_open",
      { url: "https://app.example.test" },
      "connected-operation-epoch",
    );
    expect(argv).not.toContain("--provider");
    expect(argv).not.toContain("--config");
    expect(argv).not.toContain("--cdp");
    expect(argv.join(" ")).not.toContain("browseruse");
  });

  it("missing required args throw with clear messages", () => {
    expect(() =>
      agentBrowserArgv("browser_click", {}, cfgPath, session),
    ).toThrow(/browser_click requires a non-empty string `ref`/);

    expect(() =>
      agentBrowserArgv("browser_type", { ref: "@e1" }, cfgPath, session),
    ).toThrow(/browser_type requires a non-empty string `text`/);

    expect(() =>
      agentBrowserArgv("browser_press", {}, cfgPath, session),
    ).toThrow(/browser_press requires a non-empty string `key`/);

    expect(() =>
      agentBrowserArgv("browser_read", {}, cfgPath, session),
    ).toThrow(/browser_read requires a non-empty string `ref`/);

    expect(() =>
      agentBrowserArgv("browser_screenshot", {}, cfgPath, session),
    ).toThrow(/browser_screenshot requires a non-empty string `_capturePath`/);

    expect(() =>
      agentBrowserArgv("browser_get", {}, cfgPath, session),
    ).toThrow(/browser_get requires a non-empty string `what`/);

    expect(() =>
      agentBrowserArgv("browser_get", { what: "nope" }, cfgPath, session),
    ).toThrow(/browser_get requires `what` to be one of/);

    expect(() =>
      agentBrowserScrollArgvs(cfgPath, session, "sideways", 600, 400, 300),
    ).toThrow(/browser_scroll requires `direction` to be one of/);
  });

  it("unknown tool throws", () => {
    expect(() => agentBrowserArgv("browser_nope", {}, cfgPath, session)).toThrow(
      /Unknown browser tool: browser_nope/,
    );
  });

  it("keeps browser_read_page off the generic argv mapper", () => {
    // The Desktop page-reader executor owns the one fixed eval program. A
    // caller cannot route browser_read_page through the generic argv mapper.
    expect(() =>
      agentBrowserArgv("browser_read_page", { script: "document.cookie" }, cfgPath, session),
    ).toThrow(/Unknown browser tool: browser_read_page/);
  });

  it("isBrowserTool / BROWSER_TOOLS", () => {
    expect(BROWSER_TOOLS.length).toBe(21);
    expect(isBrowserTool("browser_snapshot")).toBe(true);
    expect(isBrowserTool("browser_click")).toBe(true);
    expect(isBrowserTool("browser_type")).toBe(true);
    expect(isBrowserTool("browser_press")).toBe(true);
    expect(isBrowserTool("browser_read")).toBe(true);
    expect(isBrowserTool("browser_read_page")).toBe(true);
    expect(isBrowserTool("browser_screenshot")).toBe(true);
    expect(isBrowserTool("browser_mouse")).toBe(true);
    expect(isBrowserTool("browser_get")).toBe(true);
    expect(isBrowserTool("browser_scroll")).toBe(true);
    expect(isBrowserTool("browser_back")).toBe(true);
    expect(isBrowserTool("browser_open")).toBe(true);
    expect(isBrowserTool("desktop_see")).toBe(false);
  });

  it("classifies every current browser tool by mutation potential", () => {
    const readonly = new Set([
      "browser_snapshot",
      "browser_read",
      "browser_read_page",
      "browser_screenshot",
      "browser_get",
      "browser_wait",
    ]);
    for (const tool of BROWSER_TOOLS) {
      expect(browserToolMayMutate(tool)).toBe(!readonly.has(tool));
    }
    expect(browserToolMayMutate("browser_future_operation")).toBe(false);
  });

  it("never emits a shell string — argv is always an array of discrete tokens", () => {
    const argv = agentBrowserArgv(
      "browser_snapshot",
      { session: "a; rm -rf / #" },
      cfgPath,
      "safe-session",
    );
    expect(argv).toEqual([
      "--config",
      cfgPath,
      "--provider",
      "nautilo-browser",
      "--session",
      "safe-session",
      "snapshot",
    ]);
  });
});
