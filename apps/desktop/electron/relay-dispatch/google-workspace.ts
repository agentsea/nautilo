import {
  googleWorkspaceArgv,
  isGoogleWorkspaceTool,
  type RelayDispatchResult,
} from "@nautilo/relay";

import {
  googleAuthRequiredDispatchResult,
  isLikelyGogAuthFailure,
} from "../google-workspace-oauth.ts";
import {
  FIXED_DESKTOP_DISPATCH_NOT_HANDLED,
  type FixedDesktopDispatchHandler,
} from "./router.ts";

interface GoogleWorkspaceExecOptions {
  readonly timeout: number;
  readonly maxBuffer: number;
}

export interface GoogleWorkspaceDispatchPorts {
  readonly resolveBinary: () => string | null;
  readonly prepareKeyring: (binary: string) => Promise<void>;
  readonly authHealthy: (binary: string) => Promise<boolean>;
  readonly ensureOAuthClient: (
    binary: string,
  ) => Promise<RelayDispatchResult | null>;
  readonly execFile: (
    binary: string,
    argv: string[],
    options: GoogleWorkspaceExecOptions,
  ) => Promise<{ readonly stdout: string; readonly stderr?: string }>;
  readonly timeoutMs: number;
  readonly installHint: () => string;
}

/** Fixed Google Workspace adapter over Electron-owned runtime and OAuth ports. */
export function createGoogleWorkspaceDispatchHandler(
  ports: GoogleWorkspaceDispatchPorts,
): FixedDesktopDispatchHandler {
  return async ({ request }) => {
    if (!isGoogleWorkspaceTool(request.toolName)) {
      return FIXED_DESKTOP_DISPATCH_NOT_HANDLED;
    }

    let argv: string[];
    try {
      argv = googleWorkspaceArgv(request.args);
    } catch (error) {
      return {
        handled: true,
        result: {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }

    try {
      const binary = ports.resolveBinary();
      if (!binary) {
        return {
          handled: true,
          result: {
            status: "error",
            error: `gog is not available. ${ports.installHint()}`,
          },
        };
      }

      await ports.prepareKeyring(binary);
      let authHealthy = await ports.authHealthy(binary);
      if (!authHealthy) {
        const clientConfigError = await ports.ensureOAuthClient(binary);
        if (clientConfigError) {
          return { handled: true, result: clientConfigError };
        }
        authHealthy = await ports.authHealthy(binary);
      }
      if (!authHealthy) {
        return { handled: true, result: googleAuthRequiredDispatchResult() };
      }

      const { stdout } = await ports.execFile(binary, argv, {
        timeout: ports.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      });
      return {
        handled: true,
        result: { status: "ok", result: stdout.trim() },
      };
    } catch (error) {
      const detail = error as {
        readonly code?: string;
        readonly killed?: boolean;
        readonly stdout?: string;
        readonly stderr?: string;
        readonly message?: string;
      };
      if (detail.code === "ENOENT") {
        return {
          handled: true,
          result: {
            status: "error",
            error: `gog is not available. ${ports.installHint()}`,
          },
        };
      }
      if (detail.killed) {
        return {
          handled: true,
          result: {
            status: "error",
            error: `${request.toolName} timed out after ${ports.timeoutMs}ms`,
          },
        };
      }
      const message =
        (detail.stderr ?? detail.stdout ?? "").trim() ||
        detail.message ||
        `${request.toolName} failed`;
      if (isLikelyGogAuthFailure(message)) {
        return {
          handled: true,
          result: {
            ...googleAuthRequiredDispatchResult(),
            error: message,
          },
        };
      }
      return {
        handled: true,
        result: { status: "error", error: message },
      };
    }
  };
}
