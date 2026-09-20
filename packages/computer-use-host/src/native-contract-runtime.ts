import {
  COMPUTER_USE_NATIVE_CONTRACTS,
  NATIVE_CONTRACT_SCHEMAS,
  computerDoInputSchema,
  computerObservationResultSchema,
  computerObserveInputSchema,
  computerVerificationReceiptSchema,
  computerVerifyInputSchema,
} from "@nautilo/computer-use-contracts/native";
import {
  NATIVE_COMPATIBILITY_SCHEMAS,
  projectNativeCompatibilityResult,
  validateNativeCompatibility,
} from "@nautilo/computer-use-contracts/native-compatibility";
import { parseComputerUseHostContract } from "@nautilo/computer-use-host-protocol";
import type {
  ComputerUseHostAuthorityScope,
  ComputerUseJson,
  ComputerUseSettlement,
} from "@nautilo/computer-use-host-protocol";

import type { ComputerUseContextRegistry, ComputerUseContextScope } from "./native-context-registry.js";
import { nativeObservationResourceClaims } from "./native-resource-claims.js";
import { ComputerUseResourceCoordinator, COMPUTER_USE_WORKSTATION_STATE_RESOURCE } from "./resource-coordinator.js";
import type {
  CuaApplicationWindowsObserveRequest,
  CuaComputerDoClickRequest,
  CuaComputerDoCreateWindowRequest,
  CuaComputerDoDragDropRequest,
  CuaComputerDoMovePointerRequest,
  CuaComputerDoInvokeMenuRequest,
  CuaComputerDoPressKeyRequest,
  CuaComputerDoHotkeyRequest,
  CuaComputerDoScrollRequest,
  CuaComputerDoSetValueRequest,
  CuaComputerDoSetWindowFrameRequest,
  CuaComputerDoTypeTextRequest,
  CuaComputerLaunchRequest,
  CuaComputerUseAdapter,
  CuaComputerVerifyRequest,
  CuaWindowStateObserveRequest,
  CuaWindowRegionObserveRequest,
} from "./native-runtime.js";
import type { ComputerDoFocusRequest, ComputerObserveRequest } from "./native-semantic-contracts.js";
import type { ComputerUseContractHandler, ComputerUseContractHandlerResult } from "./runtime.js";

type NativeAdapter = Pick<CuaComputerUseAdapter,
  | "observe"
  | "observeWindowState"
  | "observeWindowRegion"
  | "observeApplicationWindows"
  | "launchApp"
  | "focus"
  | "click"
  | "dragDrop"
  | "movePointer"
  | "invokeMenu"
  | "typeText"
  | "setValue"
  | "setWindowFrame"
  | "scroll"
  | "pressKey"
  | "hotkey"
  | "createWindow"
  | "verify"
>;

type NativeDoOperation =
  | CuaComputerLaunchRequest["operation"]
  | ComputerDoFocusRequest["operation"]
  | CuaComputerDoClickRequest["operation"]
  | CuaComputerDoDragDropRequest["operation"]
  | CuaComputerDoMovePointerRequest["operation"]
  | CuaComputerDoInvokeMenuRequest["operation"]
  | CuaComputerDoTypeTextRequest["operation"]
  | CuaComputerDoSetValueRequest["operation"]
  | CuaComputerDoSetWindowFrameRequest["operation"]
  | CuaComputerDoScrollRequest["operation"]
  | CuaComputerDoPressKeyRequest["operation"]
  | CuaComputerDoHotkeyRequest["operation"]
  | CuaComputerDoCreateWindowRequest["operation"];

export type NativeComputerUseScopeFactory = (
  authority: ComputerUseHostAuthorityScope,
) => ComputerUseContextScope;

export type CuaNativeContractRuntimeOptions = Readonly<{
  adapter: NativeAdapter;
  scopeForAuthority: NativeComputerUseScopeFactory;
  coordinator?: ComputerUseResourceCoordinator;
  registry?: ComputerUseContextRegistry;
  drain?: (scope: ComputerUseContextScope, signal: AbortSignal) => Promise<void>;
}>;

/**
 * Collapse the retired Electron routing tuple onto the broker's exact opaque
 * authority lease. The lease and its generation are the sole cross-process
 * authority; repeated private fields exist only because the proven registry
 * and Cua session-key implementation still compare their historical shape.
 */
export function createNativeComputerUseScopeFactory(options: Readonly<{
  hostGeneration: string;
  driverGeneration: string;
}>): NativeComputerUseScopeFactory {
  return (authority) => ({
    computerUseContextId: authority.authorityLeaseId,
    installationEpoch: options.hostGeneration,
    grantGeneration: authority.authorityGeneration,
    provider: "cua",
    providerGeneration: options.driverGeneration,
    originHumanId: authority.authorityLeaseId,
    originRunId: authority.authorityLeaseId,
    originAgentId: authority.authorityLeaseId,
    lineageId: authority.authorityLeaseId,
    serverBindingId: options.hostGeneration,
    relayId: options.hostGeneration,
    pairingGeneration: options.hostGeneration,
    desktopSessionId: options.hostGeneration,
  });
}

function jsonRecord(value: object): Readonly<Record<string, ComputerUseJson>> {
  return value as unknown as Readonly<Record<string, ComputerUseJson>>;
}

function failed(
  operation: "desktop_state" | "window_state" | "application_windows" | "window_region" | "verify",
  outcome: object,
  signal: AbortSignal,
): ComputerUseContractHandlerResult {
  return {
    settlement: signal.aborted ? "cancelled" : "not_completed",
    result: jsonRecord({ version: 1, operation, outcome }),
  };
}

function actionSettlement(receipt: Readonly<{ completionCertainty: string }>, signal: AbortSignal): ComputerUseSettlement {
  if (signal.aborted) return "cancelled";
  if (receipt.completionCertainty === "completed") return "completed";
  if (receipt.completionCertainty === "not_completed") return "not_completed";
  return "unknown_completion";
}

/**
 * Host-owned semantic Cua execution. The model supplies only the public
 * contract arguments; authority scope, native targets, provider JSON, and PNG
 * bytes stay in this process.
 */
export class CuaNativeContractRuntime {
  readonly handlers: readonly ComputerUseContractHandler[];

  constructor(readonly options: CuaNativeContractRuntimeOptions) {
    const handlers: ComputerUseContractHandler[] = [
      {
        contract: COMPUTER_USE_NATIVE_CONTRACTS.observe,
        execute: async (argumentsValue, context) => {
          const input = computerObserveInputSchema.parse(argumentsValue);
          const scope = options.scopeForAuthority(context.authority);
          const observed = input.operation === "desktop_state"
            ? await options.adapter.observe({ ...input, scope, signal: context.signal } as ComputerObserveRequest)
            : input.operation === "window_state"
              ? await options.adapter.observeWindowState({ ...input, scope, signal: context.signal } as CuaWindowStateObserveRequest)
              : input.operation === "application_windows"
                ? await options.adapter.observeApplicationWindows({ ...input, scope, signal: context.signal } as CuaApplicationWindowsObserveRequest)
                : await options.adapter.observeWindowRegion({ ...input, scope, signal: context.signal } as CuaWindowRegionObserveRequest);
          if (!observed.ok) return failed(input.operation, observed.outcome, context.signal);
          const observation = computerObservationResultSchema.parse(observed.observation);
          const visionImage = "visionImage" in observed ? observed.visionImage : undefined;
          if (visionImage === undefined) {
            return { settlement: "completed", result: jsonRecord(observation) };
          }
          const snapshot = observation.operation === "desktop_state"
            ? observation.screenSnapshot
            : observation.operation === "window_state"
              ? observation.windowSnapshot
              : observation.operation === "window_region"
                ? observation.regionSnapshot
                : undefined;
          if (snapshot === undefined) throw new Error("Cua returned visual bytes without public snapshot authority");
          const dimensions = "presentedDimensions" in snapshot.metadata
            ? snapshot.metadata.presentedDimensions
            : snapshot.metadata.dimensions;
          return {
            settlement: "completed",
            result: jsonRecord(observation),
            attachment: {
              bytes: visionImage.bytes.slice(),
              width: dimensions.width,
              height: dimensions.height,
              coordinateSpace: "presentedDimensions" in snapshot.metadata
                ? "presented_snapshot_pixels"
                : snapshot.metadata.coordinateSpace,
            },
          };
        },
      },
      {
        contract: COMPUTER_USE_NATIVE_CONTRACTS.do,
        execute: async (argumentsValue, context) => {
          const parsed = computerDoInputSchema.parse(argumentsValue) as { operation: NativeDoOperation };
          const operation: NativeDoOperation = parsed.operation.kind === "press_key"
            ? { ...parsed.operation, modifiers: parsed.operation.modifiers ?? [] }
            : parsed.operation;
          const scope = options.scopeForAuthority(context.authority);
          const request = { scope, signal: context.signal, operation };
          const action = operation.kind === "launch_app"
            ? await options.adapter.launchApp(request as CuaComputerLaunchRequest)
            : operation.kind === "focus"
              ? await options.adapter.focus(request as ComputerDoFocusRequest)
              : operation.kind === "click"
                ? await options.adapter.click(request as CuaComputerDoClickRequest)
                : operation.kind === "move_pointer"
                  ? await options.adapter.movePointer(request as CuaComputerDoMovePointerRequest)
                : operation.kind === "drag_drop"
                  ? await options.adapter.dragDrop(request as CuaComputerDoDragDropRequest)
                  : operation.kind === "invoke_menu"
                    ? await options.adapter.invokeMenu(request as CuaComputerDoInvokeMenuRequest)
                    : operation.kind === "set_window_frame"
                      ? await options.adapter.setWindowFrame(request as CuaComputerDoSetWindowFrameRequest)
                  : operation.kind === "type_text"
                    ? await options.adapter.typeText(request as CuaComputerDoTypeTextRequest)
                    : operation.kind === "set_value"
                      ? await options.adapter.setValue(request as CuaComputerDoSetValueRequest)
                      : operation.kind === "scroll"
                        ? await options.adapter.scroll(request as CuaComputerDoScrollRequest)
                        : operation.kind === "press_key"
                          ? await options.adapter.pressKey(request as CuaComputerDoPressKeyRequest)
                          : operation.kind === "hotkey"
                            ? await options.adapter.hotkey(request as CuaComputerDoHotkeyRequest)
                          : await options.adapter.createWindow(request as CuaComputerDoCreateWindowRequest);
          const receipt = NATIVE_CONTRACT_SCHEMAS.do.result.parse(action.receipt);
          return {
            settlement: actionSettlement(receipt, context.signal),
            result: jsonRecord(receipt),
          };
        },
      },
      {
        contract: COMPUTER_USE_NATIVE_CONTRACTS.verify,
        execute: async (argumentsValue, context) => {
          const input = computerVerifyInputSchema.parse(argumentsValue);
          const scope = options.scopeForAuthority(context.authority);
          const verified = await options.adapter.verify({
            ...input,
            scope,
            signal: context.signal,
          } as CuaComputerVerifyRequest);
          if (!verified.ok) return failed("verify", verified.outcome, context.signal);
          const verification = computerVerificationReceiptSchema.parse(verified.verification);
          return { settlement: "completed", result: jsonRecord(verification) };
        },
      },
    ];
    for (const schema of NATIVE_COMPATIBILITY_SCHEMAS) {
      const current = handlers.find((handler) => handler.contract.contractId === schema.descriptor.contractId)!;
      handlers.push({
        contract: parseComputerUseHostContract(schema.descriptor),
        execute: async (args, context) => {
          if (!validateNativeCompatibility(args, schema.input)) throw new Error("Native compatibility input rejected");
          const result = await current.execute(args, context);
          const projected = projectNativeCompatibilityResult(result.result);
          if (!validateNativeCompatibility(projected, schema.result)) {
            result.attachment?.bytes.fill(0);
            throw new Error("Native compatibility result rejected");
          }
          return { ...result, result: jsonRecord(projected) };
        },
      });
    }
    const coordinator = options.coordinator ?? new ComputerUseResourceCoordinator();
    this.handlers = handlers.map((handler) => ({
      contract: handler.contract,
      execute: (args, context) => {
        const scope = options.scopeForAuthority(context.authority);
        const claims = handler.contract.contractId === COMPUTER_USE_NATIVE_CONTRACTS.observe.contractId
          ? nativeObservationResourceClaims(args, scope, options.registry)
          : [{ key: COMPUTER_USE_WORKSTATION_STATE_RESOURCE,
              mode: handler.contract.contractId === COMPUTER_USE_NATIVE_CONTRACTS.verify.contractId ? "read" as const : "write" as const }];
        return coordinator.withClaims(claims, context.signal, async () => {
          try {
            return await handler.execute(args, context);
          } finally {
            await options.drain?.(scope, context.signal);
          }
        });
      },
    }));
  }
}
