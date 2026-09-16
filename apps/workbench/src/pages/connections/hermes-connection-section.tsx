import { useCallback, useEffect, useRef, useState } from "react";
import type { AcpHarnessDescriptor, AcpHarnessReadiness } from "@nautilo/api-client/browser";
import { desktopAPI, getDesktopRelayId, isDesktop, type DesktopHermesConnectionStatus } from "../../lib/desktop";
import { apiClient } from "../../lib/api";
import { Button, StatusPill } from "../settings/ui";

type HermesSnapshot = Readonly<{
  descriptor: AcpHarnessDescriptor;
  readiness: AcpHarnessReadiness;
}>;

type AcpConnectionDefinition = Readonly<{
  id: "hermes-acp" | "opencode-acp";
  name: "Hermes" | "OpenCode";
  entrypoint: "nautilo-acp" | "opencode acp";
  ownerToggle: boolean;
}>;

const HERMES = Object.freeze({ id: "hermes-acp", name: "Hermes", entrypoint: "nautilo-acp", ownerToggle: true } as const);
const OPENCODE = Object.freeze({ id: "opencode-acp", name: "OpenCode", entrypoint: "opencode acp", ownerToggle: false } as const);

export interface HermesConnectionPorts {
  readonly getRelayId: () => Promise<string | null>;
  readonly listHarnesses: () => Promise<Readonly<{ harnesses: readonly AcpHarnessDescriptor[] }>>;
  readonly inspectReadiness: (harnessId: string, relayId: string) => Promise<AcpHarnessReadiness>;
  readonly getHermesStatus: () => Promise<DesktopHermesConnectionStatus>;
  readonly enableHermes: () => Promise<DesktopHermesConnectionStatus>;
  readonly disableHermes: () => Promise<DesktopHermesConnectionStatus>;
  readonly onRelayStatusChanged: (callback: (status: string) => void) => () => void;
}

const defaultPorts: HermesConnectionPorts = Object.freeze({
  getRelayId: getDesktopRelayId,
  listHarnesses: () => apiClient.acp.harnesses(),
  inspectReadiness: (harnessId: string, relayId: string) => apiClient.acp.readiness(harnessId, relayId),
  getHermesStatus: () => desktopAPI!.hermesConnection!.status(),
  enableHermes: () => desktopAPI!.hermesConnection!.enable(),
  disableHermes: () => desktopAPI!.hermesConnection!.disable(),
  onRelayStatusChanged: (callback: (status: string) => void) => desktopAPI!.relayStatus.onChange(callback),
});

function readinessPill(readiness: AcpHarnessReadiness | null): {
  readonly tone: "ok" | "warn" | "error" | "info" | "muted";
  readonly label: string;
} {
  if (!readiness) return { tone: "info", label: "Checking" };
  switch (readiness.state) {
    case "ready": return { tone: "ok", label: "Ready" };
    case "missing": return { tone: "muted", label: "Not installed" };
    case "incompatible": return { tone: "warn", label: "Incompatible" };
    case "authentication_required": return { tone: "warn", label: "Sign-in needed" };
    case "unavailable": return { tone: "error", label: "Unavailable" };
  }
}

/**
 * Read-only ACP product surface. Each native harness owns its provider, model,
 * authentication, and permissions; Nautilo proves only that the reviewed ACP
 * entrypoint on this exact paired desktop is ready for a new Task.
 */
function AcpConnectionSection({
  definition,
  isDesktopShell = isDesktop,
  ports = defaultPorts,
}: {
  readonly definition: AcpConnectionDefinition;
  readonly isDesktopShell?: boolean;
  readonly ports?: HermesConnectionPorts;
}) {
  const [expanded, setExpanded] = useState(true);
  const [snapshot, setSnapshot] = useState<HermesSnapshot | null>(null);
  const [ownerEnabled, setOwnerEnabled] = useState<boolean | null>(definition.ownerToggle ? null : true);
  const [relayStarting, setRelayStarting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const generationRef = useRef(0);
  const ownerEnabledRef = useRef<boolean | null>(definition.ownerToggle ? null : true);

  const refresh = useCallback(async (enabled: boolean) => {
    if (!isDesktopShell || enabled === false || enabled === null) return;
    const generation = ++generationRef.current;
    setBusy(true);
    setFailed(false);
    try {
      const catalogue = await ports.listHarnesses();
      const descriptor = catalogue.harnesses.find((item) => item.id === definition.id);
      const relayId = await ports.getRelayId();
      if (!relayId) {
        if (generation === generationRef.current) {
          setSnapshot(null);
          setRelayStarting(true);
        }
        return;
      }
      if (!descriptor) throw new Error("ACP host unavailable");
      setRelayStarting(false);
      const readiness = await ports.inspectReadiness(descriptor.id, relayId);
      if (generation !== generationRef.current) return;
      setSnapshot({ descriptor, readiness });
    } catch {
      if (generation !== generationRef.current) return;
      setSnapshot(null);
      setFailed(true);
    } finally {
      if (generation === generationRef.current) setBusy(false);
    }
  }, [definition.id, isDesktopShell, ports]);

  useEffect(() => {
    if (!isDesktopShell) return;
    let cancelled = false;
    const unsubscribe = ports.onRelayStatusChanged((status) => {
      if (cancelled || ownerEnabledRef.current === false) return;
      if (status === "connected") void refresh(true);
      else {
        setRelayStarting(true);
        setSnapshot(null);
      }
    });
    if (definition.ownerToggle) {
      void ports.getHermesStatus().then((status) => {
        if (cancelled) return;
        ownerEnabledRef.current = status.enabled;
        setOwnerEnabled(status.enabled);
        setRelayStarting(status.enabled && status.relay !== "connected");
        if (status.enabled && status.relay === "connected") void refresh(true);
      }).catch(() => {
        if (!cancelled) setFailed(true);
      });
    } else {
      void refresh(true);
    }
    return () => {
      cancelled = true;
      generationRef.current += 1;
      unsubscribe();
    };
  }, [definition.ownerToggle, isDesktopShell, ports, refresh]);

  const toggleOwner = async (enabled: boolean) => {
    if (!definition.ownerToggle || busy) return;
    generationRef.current += 1;
    setBusy(true);
    setFailed(false);
    try {
      const status = enabled ? await ports.enableHermes() : await ports.disableHermes();
      ownerEnabledRef.current = status.enabled;
      setOwnerEnabled(status.enabled);
      setSnapshot(null);
      setRelayStarting(status.enabled && status.relay !== "connected");
      if (status.enabled && status.relay === "connected") queueMicrotask(() => { void refresh(true); });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const pill = ownerEnabled === false
    ? { tone: "muted" as const, label: "Off" }
    : relayStarting
      ? { tone: "info" as const, label: "Starting" }
      : failed
    ? { tone: "error" as const, label: "Check failed" }
    : readinessPill(snapshot?.readiness ?? null);

  return (
    <section
      id={definition.id}
      className="scroll-mt-6 rounded-lg border border-border bg-background-panel"
      aria-labelledby={`${definition.id}-connection-title`}
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 id={`${definition.id}-connection-title`} className="text-sm font-semibold">{definition.name} via ACP</h2>
          <p className="mt-1 text-xs text-foreground-muted">
            {expanded
              ? `Use the reviewed ${definition.name} agent installed on this desktop.`
              : snapshot?.readiness.state === "ready"
                ? `Ready for a new ${definition.name} Task.`
                : `${definition.name} readiness on this desktop.`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isDesktopShell ? <StatusPill tone={pill.tone}>{pill.label}</StatusPill> : null}
          {isDesktopShell && definition.ownerToggle ? <button
            type="button"
            role="switch"
            aria-checked={ownerEnabled === true}
            aria-label={ownerEnabled ? "Disable Hermes" : "Enable Hermes"}
            disabled={busy || ownerEnabled === null}
            onClick={() => { void toggleOwner(ownerEnabled !== true); }}
            className={[
              "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
              ownerEnabled ? "bg-[var(--success)]" : "bg-foreground-muted/40",
              busy || ownerEnabled === null ? "cursor-not-allowed opacity-50" : "cursor-pointer",
            ].join(" ")}
          ><span className={[
            "inline-block h-4 w-4 rounded-full bg-background shadow transition-transform",
            ownerEnabled ? "translate-x-4" : "translate-x-0.5",
            busy ? "animate-pulse" : "",
          ].join(" ")} /></button> : null}
          <button
            type="button"
            className="rounded px-2 py-1 text-xs font-medium text-foreground-muted hover:bg-background-element hover:text-foreground"
            aria-expanded={expanded}
            aria-controls={`${definition.id}-connection-details`}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "Collapse" : "Expand"}
          </button>
        </div>
      </header>

      {expanded ? (
        <div id={`${definition.id}-connection-details`} className="space-y-3 px-4 py-3">
          {!isDesktopShell ? (
            <p className="text-sm text-foreground-muted">Open Nautilo desktop to check {definition.name}.</p>
          ) : ownerEnabled === false ? (
            <p className="text-sm text-foreground-muted">{definition.name} is off. Turn it on to make it available for Tasks and Ready to work.</p>
          ) : relayStarting ? (
            <p className="text-sm text-foreground-muted">Waiting for the Desktop relay before checking {definition.name}…</p>
          ) : busy && !snapshot ? (
            <p className="text-sm text-foreground-muted">Checking {definition.name} on this desktop…</p>
          ) : failed ? (
            <p className="text-sm text-[var(--error)]" role="alert">
              Nautilo could not check {definition.name} on this paired desktop.
            </p>
          ) : snapshot ? (
            <p className="text-sm text-foreground-muted">
              {snapshot.readiness.action ?? `${definition.name} is ready for a new Task on this desktop.`}
            </p>
          ) : null}

          <dl className="grid gap-2 border-t border-border/60 pt-3 text-xs sm:grid-cols-[9rem_1fr]">
            <dt className="font-medium text-foreground">Runtime</dt>
            <dd className="text-foreground-muted">External {definition.name} installation</dd>
            <dt className="font-medium text-foreground">ACP entrypoint</dt>
            <dd className="text-foreground-muted"><code>{definition.entrypoint}</code></dd>
            <dt className="font-medium text-foreground">Provider and model</dt>
            <dd className="text-foreground-muted">Managed in {definition.name}</dd>
            <dt className="font-medium text-foreground">Permissions</dt>
            <dd className="text-foreground-muted">Managed in {definition.name}; Nautilo request handling is unsupported</dd>
            <dt className="font-medium text-foreground">Lifecycle</dt>
            <dd className="text-foreground-muted">A fresh ACP process starts for each accepted Task</dd>
          </dl>

          <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-3">
            <p className="text-xs text-foreground-dim">
              Nautilo does not inspect {definition.name} accounts, keys, provider inventory, or model settings.
            </p>
            {isDesktopShell && ownerEnabled !== false && !relayStarting ? (
              <Button variant="ghost" loading={busy} onClick={() => void refresh(true)}>
                Check again
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function HermesConnectionSection(props: Readonly<{
  isDesktopShell?: boolean;
  ports?: HermesConnectionPorts;
}>) {
  return <AcpConnectionSection definition={HERMES} {...props} />;
}

export function OpenCodeConnectionSection(props: Readonly<{
  isDesktopShell?: boolean;
  ports?: HermesConnectionPorts;
}>) {
  return <AcpConnectionSection definition={OPENCODE} {...props} />;
}
