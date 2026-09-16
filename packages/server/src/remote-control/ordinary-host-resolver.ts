import type {
  OrdinaryHostResolver,
  OrdinaryHostResolution,
} from "@nautilo/agent";
import { randomUUID } from "node:crypto";
import { HEARTBEAT_TIMEOUT_MS, RELAY_PROTOCOL_VERSION } from "@nautilo/relay";
import type { RemotePairingStore } from "./pairing-store";

type LiveHost = {
  readonly relayId: string;
  readonly pairingGeneration: string;
  readonly userId: string;
  readonly desktopSessionId: string | null;
  readonly protocolVersion: number;
  readonly capabilityRevision: number;
  readonly lastSeenAt: number;
  readonly capabilities: { readonly profile: string };
};

export interface OrdinaryHostRegistry {
  snapshotForUser(userId: string): LiveHost[];
  getCapabilities(relayId: string): Record<string, unknown> | null | undefined;
}

/**
 * Joins one verified controller to exact active bindings and current live
 * Relay generations. It never chooses among several eligible computers.
 */
export function createOrdinaryHostResolver(input: {
  pairingStore: Pick<RemotePairingStore, "listActiveHostBindingsForController">;
  registry: OrdinaryHostRegistry;
  now?: () => number;
  newOpaqueId?: () => string;
}): OrdinaryHostResolver {
  const now = input.now ?? Date.now;
  const newOpaqueId = input.newOpaqueId ?? randomUUID;
  const ttlMs = 5 * 60 * 1000;
  type Eligible = {
    relayId: string;
    bindingId: string;
    pairingGeneration: string;
    desktopSessionId: string;
    capabilityRevision: number;
    workspaceRoot?: string;
    currentFolderRoot?: string;
    label: string;
  };
  const choices = new Map<string, {
    expiresAt: number;
    requestId: string;
    toolCallId: string;
    bySelector: Map<string, { relayId: string; bindingId: string }>;
    options: Array<{ selector: string; label: string }>;
  }>();
  const choiceBySelectionKey = new Map<string, string>();
  type Selected = Omit<Eligible, "label">;
  const selections = new Map<string, Selected & {
    expiresAt: number;
  }>();
  const selectionKey = (requestId: string, toolCallId: string) => `${requestId}:${toolCallId}`;
  const selectedHost = (eligible: Eligible): Selected => {
    const { label: _label, ...host } = eligible;
    return host;
  };
  const sameSelection = (current: Eligible, prior: Selected): boolean =>
    current.relayId === prior.relayId &&
    current.bindingId === prior.bindingId &&
    current.pairingGeneration === prior.pairingGeneration &&
    current.desktopSessionId === prior.desktopSessionId &&
    current.capabilityRevision === prior.capabilityRevision &&
    current.workspaceRoot === prior.workspaceRoot &&
    current.currentFolderRoot === prior.currentFolderRoot;
  return {
    async resolve(request): Promise<OrdinaryHostResolution> {
      const { origin } = request;
      const nowMs = now();
      if (origin.kind === "local_electron") {
        const exact = input.registry.snapshotForUser(origin.userId).filter(
          (live) =>
            live.relayId === origin.relayId &&
            live.pairingGeneration === origin.pairingGeneration &&
            live.desktopSessionId === origin.desktopSessionId,
        );
        // Duplicate live identity is split-brain, never an arbitrary winner.
        if (exact.length !== 1) return { status: "unavailable" };
        const live = exact[0]!;
        const capabilities = input.registry.getCapabilities(live.relayId);
        if (
          live.userId !== origin.userId ||
          live.protocolVersion < RELAY_PROTOCOL_VERSION ||
          live.capabilities.profile !== "desktop-agent" ||
          !Number.isFinite(live.lastSeenAt) ||
          live.lastSeenAt > nowMs ||
          nowMs - live.lastSeenAt > HEARTBEAT_TIMEOUT_MS ||
          (request.hostedBy && live.relayId !== request.hostedBy) ||
          capabilities?.[request.relayCapability] !== true
        ) return { status: "unavailable" };
        return {
          status: "selected",
          host: {
            relayId: live.relayId,
            pairingGeneration: live.pairingGeneration,
            desktopSessionId: origin.desktopSessionId,
            capabilityRevision: live.capabilityRevision,
            ...(nonBlankCapability(capabilities, "workspaceRoot")
              ? { workspaceRoot: capabilities["workspaceRoot"] as string }
              : {}),
            ...(nonBlankCapability(capabilities, "currentFolderRoot")
              ? { currentFolderRoot: capabilities["currentFolderRoot"] as string }
              : {}),
          },
        };
      }
      const bindings = await input.pairingStore.listActiveHostBindingsForController({
        controllerInstallationId: origin.controllerInstallationId,
        installationGeneration: origin.installationGeneration,
        userId: origin.userId,
        actorId: origin.actorId,
        serverInstanceId: origin.serverInstanceId,
        serverBindingGeneration: origin.serverBindingGeneration,
      });
      if (bindings.length === 0) return { status: "unavailable" };

      const generations = new Set(bindings.map((binding) => binding.pairingGeneration));
      const byGeneration = new Map<string, LiveHost[]>();
      for (const live of input.registry.snapshotForUser(origin.userId)) {
        if (!generations.has(live.pairingGeneration)) continue;
        const current = byGeneration.get(live.pairingGeneration);
        if (current) current.push(live);
        else byGeneration.set(live.pairingGeneration, [live]);
      }

      const eligibleByRelay = new Map<string, Eligible>();
      for (const binding of bindings) {
        const exact = byGeneration.get(binding.pairingGeneration) ?? [];
        // A duplicate exact generation is split-brain, never a choice.
        if (exact.length !== 1) continue;
        const live = exact[0]!;
        if (
          live.userId !== origin.userId ||
          live.protocolVersion < RELAY_PROTOCOL_VERSION ||
          live.capabilities.profile !== "desktop-agent" ||
          !live.desktopSessionId ||
          !Number.isFinite(live.lastSeenAt) ||
          live.lastSeenAt > nowMs ||
          nowMs - live.lastSeenAt > HEARTBEAT_TIMEOUT_MS ||
          (request.hostedBy && live.relayId !== request.hostedBy)
        ) continue;
        const capabilities = input.registry.getCapabilities(live.relayId);
        if (capabilities?.[request.relayCapability] !== true) continue;
        eligibleByRelay.set(live.relayId, {
          relayId: live.relayId,
          bindingId: binding.bindingId,
          pairingGeneration: binding.pairingGeneration,
          desktopSessionId: live.desktopSessionId,
          capabilityRevision: live.capabilityRevision,
          ...(nonBlankCapability(capabilities, "workspaceRoot")
            ? { workspaceRoot: capabilities["workspaceRoot"] as string }
            : {}),
          ...(nonBlankCapability(capabilities, "currentFolderRoot")
            ? { currentFolderRoot: capabilities["currentFolderRoot"] as string }
            : {}),
          label: binding.label,
        });
      }

      const eligible = [...eligibleByRelay.values()];
      if (eligible.length === 0) return { status: "unavailable" };
      const key = selectionKey(origin.requestId, request.toolCallId);
      // A submitted selector is a one-use credential. Check it before the
      // cached selection so a duplicate reply cannot be mistaken for a valid
      // replay of the already-resolved tool call.
      if (request.choice) {
        const challenge = choices.get(request.choice.choiceId);
        choices.delete(request.choice.choiceId);
        if (choiceBySelectionKey.get(key) === request.choice.choiceId) {
          choiceBySelectionKey.delete(key);
        }
        const selected = challenge?.bySelector.get(request.choice.selector);
        if (
          !challenge ||
          challenge.expiresAt <= nowMs ||
          challenge.requestId !== origin.requestId ||
          challenge.toolCallId !== request.toolCallId ||
          !selected
        ) return { status: "unavailable" };
        const current = eligible.find(
          (host) => host.relayId === selected.relayId && host.bindingId === selected.bindingId,
        );
        if (!current) return { status: "unavailable" };
        const selectedSnapshot = selectedHost(current);
        selections.set(key, {
          expiresAt: nowMs + ttlMs,
          ...selectedSnapshot,
        });
        return { status: "selected", host: selectedSnapshot };
      }
      const prior = selections.get(key);
      if (prior) {
        if (prior.expiresAt <= nowMs) selections.delete(key);
        else {
          const current = eligible.find((host) => sameSelection(host, prior));
          if (current) {
            return { status: "selected", host: selectedHost(current) };
          }
          selections.delete(key);
          return { status: "unavailable" };
        }
      }
      if (eligible.length > 1) {
        const existingChoiceId = choiceBySelectionKey.get(key);
        const existingChoice = existingChoiceId ? choices.get(existingChoiceId) : undefined;
        if (existingChoice && existingChoice.expiresAt > nowMs) {
          return {
            status: "choice_required",
            choiceId: existingChoiceId!,
            options: existingChoice.options,
          };
        }
        if (existingChoiceId) {
          choices.delete(existingChoiceId);
          choiceBySelectionKey.delete(key);
        }
        const choiceId = newOpaqueId();
        const bySelector = new Map<string, { relayId: string; bindingId: string }>();
        const options = eligible
          .sort((a, b) => a.label.localeCompare(b.label) || a.bindingId.localeCompare(b.bindingId))
          .map((host, index) => {
            const selector = newOpaqueId();
            bySelector.set(selector, { relayId: host.relayId, bindingId: host.bindingId });
            return {
              selector,
              label: host.label.trim().slice(0, 80) || `Computer ${index + 1}`,
            };
          });
        choices.set(choiceId, {
          expiresAt: nowMs + ttlMs,
          requestId: origin.requestId,
          toolCallId: request.toolCallId,
          bySelector,
          options,
        });
        choiceBySelectionKey.set(key, choiceId);
        return { status: "choice_required", choiceId, options };
      }
      const host = selectedHost(eligible[0]!);
      selections.set(key, { expiresAt: nowMs + ttlMs, ...host });
      return { status: "selected", host };
    },
  };
}

function nonBlankCapability(
  capabilities: Record<string, unknown> | null | undefined,
  key: "workspaceRoot" | "currentFolderRoot",
): boolean {
  return typeof capabilities?.[key] === "string" && capabilities[key].length > 0;
}
