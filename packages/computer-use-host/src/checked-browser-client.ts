import type { ComputerUseHostAuthorityScope } from "@nautilo/computer-use-host-protocol";

import type { CuaToolClient, CuaToolResult } from "./cua-client.js";
import type { CuaCheckedContextPort } from "./native-cua-lifecycle.js";
import type { ComputerUseContextScope } from "./native-context-registry.js";
import type { NativeComputerUseScopeFactory } from "./native-contract-runtime.js";
import type { CuaBrowserToolName } from "./native-cua-supervisor.js";

type RetainedBrowserSession = Readonly<{
  authority: ComputerUseHostAuthorityScope;
  scope: ComputerUseContextScope;
  generation: string;
  sessionId: string;
}>;

const BROWSER_TOOLS = new Set<CuaBrowserToolName>([
  "browser_prepare",
  "get_browser_state",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_pointer",
  "browser_dialog",
  "list_windows",
  "bring_to_front",
  "hotkey",
  "type_text",
  "press_key",
]);

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function sameAuthority(left: ComputerUseHostAuthorityScope, right: ComputerUseHostAuthorityScope): boolean {
  return left.authorityLeaseId === right.authorityLeaseId
    && left.authorityGeneration === right.authorityGeneration;
}

/**
 * Browser adapter for the Host-owned checked Cua daemon. Public browser code
 * keeps a random session alias; only this class maps it to the supervisor's
 * exact authority-derived session and checked generation.
 */
export class CuaCheckedBrowserClient implements CuaToolClient {
  readonly #sessions = new Map<string, RetainedBrowserSession>();

  constructor(private readonly options: Readonly<{
    port: CuaCheckedContextPort;
    scopeForAuthority: NativeComputerUseScopeFactory;
  }>) {}

  async callTool(
    name: string,
    argumentsValue: Readonly<Record<string, unknown>>,
    context?: Readonly<{ authority: ComputerUseHostAuthorityScope; signal?: AbortSignal }>,
  ): Promise<CuaToolResult> {
    if (context === undefined) throw new Error("cua_browser_authority_required");
    const alias = argumentsValue["session"];
    // BrowserRuntime authors this exact opaque alias. Do not impose a second,
    // unrelated string ceiling at the checked-Cua bridge.
    if (typeof alias !== "string" || !/^nautilo-browser_[A-Za-z0-9_-]{43}$/u.test(alias)) {
      throw new Error("cua_browser_session_invalid");
    }
    if (name === "start_session") {
      if (!exactKeys(argumentsValue, ["session"]) || this.#sessions.has(alias)) {
        throw new Error("cua_browser_session_invalid");
      }
      const scope = this.options.scopeForAuthority(context.authority);
      const started = await this.options.port.startBrowserContext(scope, context.signal);
      if (!started.ok || started.generation !== this.options.port.generation) {
        throw new Error("cua_browser_session_unavailable");
      }
      this.#sessions.set(alias, {
        authority: context.authority,
        scope,
        generation: started.generation,
        sessionId: started.sessionId,
      });
      return { isError: false, structuredContent: { status: "ok" } };
    }

    const retained = this.#sessions.get(alias);
    if (retained === undefined || !sameAuthority(retained.authority, context.authority)
      || retained.generation !== this.options.port.generation) {
      throw new Error("cua_browser_session_fenced");
    }
    if (name === "end_session") {
      if (!exactKeys(argumentsValue, ["session"])) throw new Error("cua_browser_session_invalid");
      this.#sessions.delete(alias);
      await this.options.port.endContextLease(retained.scope, retained.generation, retained.sessionId);
      return { isError: false, structuredContent: { status: "ok" } };
    }
    if (!BROWSER_TOOLS.has(name as CuaBrowserToolName)) throw new Error("cua_browser_tool_rejected");

    const providerArguments = name === "bring_to_front" || name === "list_windows"
      ? Object.fromEntries(Object.entries(argumentsValue).filter(([key]) => key !== "session"))
      : { ...argumentsValue, session: retained.sessionId };
    const called = await (async () => {
      try {
        return await this.options.port.callBrowserTool(
          retained.scope, retained.sessionId, name as CuaBrowserToolName,
          providerArguments, context.signal,
        );
      } finally {
        // Caller cancellation is not provider completion. Browser resource
        // claims remain held until this exact request's owned RPCs drain.
        await this.options.port.awaitOutstandingOperations?.(retained.scope, context.signal);
      }
    })();
    if (!called.ok || called.generation !== retained.generation || called.sessionId !== retained.sessionId) {
      throw new Error("cua_browser_call_unavailable");
    }
    return {
      isError: called.result.isError,
      structuredContent: called.result.structuredContent,
    };
  }

  async close(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(sessions.map((session) => this.options.port.endContextLease(
      session.scope,
      session.generation,
      session.sessionId,
    )));
  }
}
