import {
  parseRelayBrowserResearchConsentRecoveryRequest,
  parseRelayBrowserResearchReadRequest,
  parseRelayBrowserResearchSearchRequest,
  parseRelayBrowserResearchSnapshotInspectionRequest,
  type RelayBrowserResearchConsentRecoveryRequest,
  type RelayBrowserResearchReadRequest,
  type RelayBrowserResearchSearchRequest,
  type RelayDispatchResult,
} from "@nautilo/relay";

import {
  dispatchBrowserPageContinuation,
  dispatchBrowserPageSnapshotInspection,
} from "../browser-page-read-dispatch.ts";
import type { BrowserPageSnapshotStore } from "../browser-page-snapshot-store.ts";
import {
  FIXED_DESKTOP_DISPATCH_NOT_HANDLED,
  type FixedDesktopDispatchHandler,
} from "./router.ts";

export interface BrowserResearchDispatchDependencies {
  readonly read?: ((
    request: RelayBrowserResearchReadRequest,
    signal?: AbortSignal,
    options?: { readonly publishSnapshotReference?: boolean },
  ) => Promise<RelayDispatchResult>) | undefined;
  readonly consentRecovery?: ((
    request: RelayBrowserResearchConsentRecoveryRequest,
    signal?: AbortSignal,
  ) => Promise<RelayDispatchResult>) | undefined;
  readonly search?: ((
    request: RelayBrowserResearchSearchRequest,
    signal?: AbortSignal,
  ) => Promise<RelayDispatchResult>) | undefined;
  readonly snapshotStore?: BrowserPageSnapshotStore | undefined;
}

/**
 * Fixed browser-research admission and result adapter. Electron retains every
 * executor and snapshot-store lifecycle; this handler only parses one request,
 * selects the established operation precedence, and forwards local bindings.
 */
export function createBrowserResearchDispatchHandler(
  dependencies: BrowserResearchDispatchDependencies,
): FixedDesktopDispatchHandler {
  return async ({ request, signal }) => {
    // D504 internal operations are recognized before every generic class so a
    // mislabeled frame cannot fall through into desktop or interactive browser.
    if (request.toolName === "browser_research_read") {
      if (request.args["consentRecovery"] !== undefined) {
        const parsed = parseRelayBrowserResearchConsentRecoveryRequest(request.args);
        if (
          request.executionClass !== "browser" ||
          request.impact !== "read-only" ||
          !parsed.ok ||
          dependencies.consentRecovery === undefined
        ) {
          return {
            handled: true,
            result: {
              status: "error",
              error: "browser research consent recovery is unavailable",
            },
          };
        }
        return {
          handled: true,
          result: await dependencies.consentRecovery(parsed.request, signal),
        };
      }

      if (request.args["snapshot"] !== undefined) {
        const parsed = parseRelayBrowserResearchSnapshotInspectionRequest(request.args);
        if (
          request.executionClass !== "browser" ||
          request.impact !== "read-only" ||
          !parsed.ok
        ) {
          return {
            handled: true,
            result: {
              status: "error",
              error: "browser research snapshot is unavailable",
            },
          };
        }
        return {
          handled: true,
          result: dispatchBrowserPageSnapshotInspection(
            { snapshot: parsed.request.snapshot },
            {
              ...(dependencies.snapshotStore === undefined
                ? {}
                : { snapshotStore: dependencies.snapshotStore }),
              ...(request.browserPageOwnerBinding === undefined
                ? {}
                : { snapshotOwner: request.browserPageOwnerBinding }),
              ...(request.browserPageSnapshotReferencePublication === true
                ? { publishSnapshotReference: true }
                : {}),
              expectedTargetRole: "research",
            },
          ),
        };
      }

      const parsed = parseRelayBrowserResearchReadRequest(request.args);
      if (
        request.executionClass !== "browser" ||
        request.impact !== "read-only" ||
        !parsed.ok
      ) {
        return {
          handled: true,
          result: {
            status: "error",
            error: "browser research read is unavailable",
          },
        };
      }
      if ("continuation" in parsed.request) {
        return {
          handled: true,
          result: dispatchBrowserPageContinuation(
            {
              continuation: parsed.request.continuation,
              ...(parsed.request.maxChars === undefined
                ? {}
                : { maxChars: parsed.request.maxChars }),
            },
            {
              ...(dependencies.snapshotStore === undefined
                ? {}
                : { snapshotStore: dependencies.snapshotStore }),
              ...(request.browserPageOwnerBinding === undefined
                ? {}
                : { snapshotOwner: request.browserPageOwnerBinding }),
              ...(request.browserPageSnapshotReferencePublication === true
                ? { publishSnapshotReference: true }
                : {}),
              expectedTargetRole: "research",
            },
          ),
        };
      }
      if (dependencies.read === undefined) {
        return {
          handled: true,
          result: {
            status: "error",
            error: "browser research read is unavailable",
          },
        };
      }
      return {
        handled: true,
        result: await dependencies.read(
          parsed.request,
          signal,
          ...(request.browserPageSnapshotReferencePublication === true
            ? [{ publishSnapshotReference: true }]
            : []),
        ),
      };
    }

    if (request.toolName === "browser_research_search") {
      const parsed = parseRelayBrowserResearchSearchRequest(request.args);
      if (
        request.executionClass !== "browser" ||
        request.impact !== "read-only" ||
        !parsed.ok ||
        dependencies.search === undefined
      ) {
        return {
          handled: true,
          result: {
            status: "error",
            error: "browser research search is unavailable",
          },
        };
      }
      return {
        handled: true,
        result: await dependencies.search(parsed.request, signal),
      };
    }

    return FIXED_DESKTOP_DISPATCH_NOT_HANDLED;
  };
}
