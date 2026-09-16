import { useState } from "react";
import type { SecurityPosture } from "../../contexts/posture-context";
import { apiClient } from "../../lib/api";
import { PinDialog } from "../pin-dialog";

type NetworkPolicy = SecurityPosture["networkPolicy"];
type NetworkMode = NetworkPolicy["mode"];
type NetworkAllowRule = Extract<NetworkPolicy, { mode: "proxy-allowlist" }>["allow"][number];

export function PostureEditModal({
  posture,
  canManageServerSecurity,
  canManageUncontainedHostCommands,
  onClose,
  onUpdated,
}: {
  readonly posture: SecurityPosture;
  readonly canManageServerSecurity: boolean;
  readonly canManageUncontainedHostCommands: boolean;
  readonly onClose: () => void;
  readonly onUpdated: () => Promise<void>;
}) {
  const [deploymentMode, setDeploymentMode] = useState(posture.deploymentMode);
  const [securityLevel, setSecurityLevel] = useState(posture.securityLevel);
  const [networkTouched, setNetworkTouched] = useState(false);
  const [networkMode, setNetworkMode] = useState<NetworkMode>(posture.networkPolicy.mode);
  const [allowlistText, setAllowlistText] = useState(
    posture.networkPolicy.mode === "proxy-allowlist"
      ? formatAllowlist(posture.networkPolicy.allow)
      : "",
  );
  const [allowUncontainedHostCommands, setAllowUncontainedHostCommands] = useState(
    posture.allowUncontainedHostCommands,
  );
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const parsedNetwork = networkTouched
    ? parseNetworkPolicy(networkMode, allowlistText)
    : { ok: true as const, policy: undefined };
  const ordinaryPostureChanged = canManageServerSecurity && (
    deploymentMode !== posture.deploymentMode ||
    securityLevel !== posture.securityLevel ||
    (networkTouched && parsedNetwork.ok && JSON.stringify(parsedNetwork.policy) !== JSON.stringify(posture.networkPolicy))
  );
  const uncontainedHostCommandsChanged =
    canManageUncontainedHostCommands &&
    allowUncontainedHostCommands !== posture.allowUncontainedHostCommands;
  const changed = ordinaryPostureChanged || uncontainedHostCommandsChanged;

  const submitPin = async (pin: string) => {
    try {
      const network = networkTouched ? parseNetworkPolicy(networkMode, allowlistText) : undefined;
      if (network?.ok === false) {
        setError(network.error);
        return;
      }
      await apiClient.updateSecurityPosture({
        ...(canManageServerSecurity && deploymentMode !== posture.deploymentMode ? { deploymentMode } : {}),
        ...(canManageServerSecurity && securityLevel !== posture.securityLevel ? { securityLevel } : {}),
        ...(canManageServerSecurity && networkTouched && network?.policy && JSON.stringify(network.policy) !== JSON.stringify(posture.networkPolicy)
          ? { networkPolicy: network.policy }
          : {}),
        ...(canManageUncontainedHostCommands && uncontainedHostCommandsChanged
          ? { allowUncontainedHostCommands }
          : {}),
        pin,
      });
      await onUpdated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <div
        data-testid="security-posture-edit-overlay"
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      >
        <div className="w-full max-w-lg rounded-lg border border-border-strong bg-background-panel p-5 shadow-xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">Change security posture</h2>
              <p className="mt-1 text-sm text-foreground-muted">
                This change is capability-gated, PIN-confirmed, and written to the audit log.
              </p>
            </div>
            <button onClick={onClose} className="text-foreground-muted hover:text-foreground">
              Close
            </button>
          </div>

          <div className="mt-5 grid gap-4">
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Deployment mode</span>
              <select
                value={deploymentMode}
                disabled={!canManageServerSecurity}
                onChange={(e) => {
                  const next = e.target.value as SecurityPosture["deploymentMode"];
                  setDeploymentMode(next);
                  if (!networkTouched) setNetworkMode(defaultNetworkPolicyForDeployment(next).mode);
                }}
                className="rounded-md border border-border bg-background-element px-3 py-2"
              >
                <option value="server">server</option>
                <option value="desktop-permissive">desktop-permissive</option>
                <option value="desktop-locked">desktop-locked</option>
              </select>
            </label>

            <label className="grid gap-1 text-sm">
              <span className="font-medium">Security level</span>
              <select
                value={securityLevel}
                disabled={!canManageServerSecurity}
                onChange={(e) => setSecurityLevel(e.target.value as SecurityPosture["securityLevel"])}
                className="rounded-md border border-border bg-background-element px-3 py-2"
              >
                <option value="yolo">yolo</option>
                <option value="permissive">permissive</option>
                <option value="standard">standard</option>
                <option value="cautious">cautious</option>
                <option value="paranoid">paranoid</option>
              </select>
            </label>

            <label className="grid gap-1 text-sm">
              <span className="font-medium">Network mode</span>
              <select
                value={networkMode}
                disabled={!canManageServerSecurity}
                onChange={(e) => {
                  setNetworkTouched(true);
                  setNetworkMode(e.target.value as NetworkMode);
                }}
                className="rounded-md border border-border bg-background-element px-3 py-2"
              >
                <option value="isolated">isolated — deny outbound network</option>
                <option value="proxy-allowlist">proxy-allowlist — allow listed destinations</option>
                <option value="host">host — broad host networking</option>
              </select>
              <span className="text-xs text-foreground-muted">
                Server/paranoid defaults to isolated. Host mode is broad egress.
              </span>
            </label>

            {networkMode === "proxy-allowlist" ? (
              <label className="grid gap-1 text-sm">
                <span className="font-medium">Network allowlist</span>
                <textarea
                  value={allowlistText}
                  disabled={!canManageServerSecurity}
                  onChange={(e) => {
                    setNetworkTouched(true);
                    setAllowlistText(e.target.value);
                  }}
                  rows={5}
                  placeholder={"domain api.openai.com 443\nwildcard github.com 443\ncidr 10.0.0.0/8 443"}
                  className="rounded-md border border-border bg-background-element px-3 py-2 font-mono text-xs"
                />
                <span className="text-xs text-foreground-muted">
                  One rule per line: <code>domain host [ports]</code>, <code>wildcard suffix [ports]</code>, or <code>cidr range [ports]</code>.
                </span>
              </label>
            ) : null}

            <section className="rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-4">
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  aria-label="Allow uncontained host commands"
                  checked={allowUncontainedHostCommands}
                  disabled={!canManageUncontainedHostCommands}
                  onChange={(event) => setAllowUncontainedHostCommands(event.target.checked)}
                  className="mt-1"
                />
                <span>
                  <span className="block font-medium">Allow uncontained host commands</span>
                  <span className="mt-1 block text-foreground-muted">
                    Disabled by default. Enabling this only permits eligible,
                    explicitly granted Humans to activate uncontained commands
                    in their own Desktop session; it activates nobody by itself. Those commands can
                    read, modify, transmit, or delete user-accessible data.
                  </span>
                  {!canManageUncontainedHostCommands ? (
                    <span className="mt-1 block text-foreground-muted">
                      Requires manage_uncontained_host_commands.
                    </span>
                  ) : null}
                </span>
              </label>
            </section>
          </div>

          {parsedNetwork.ok === false ? (
            <div className="mt-3 rounded-md border border-[var(--error)]/40 bg-[var(--error)]/10 p-3 text-sm text-[var(--error)]">
              {parsedNetwork.error}
            </div>
          ) : null}

          <div className="mt-5 rounded-md border border-border bg-background-element p-3 text-sm">
            <div>Mode: {posture.deploymentMode} -&gt; {deploymentMode}</div>
            <div>Level: {posture.securityLevel} -&gt; {securityLevel}</div>
            <div>Network: {posture.networkPolicy.mode} -&gt; {networkMode}</div>
            <div>
              Uncontained host commands: {posture.allowUncontainedHostCommands ? "Enabled" : "Disabled"}
              {" -&gt; "}
              {allowUncontainedHostCommands ? "Enabled" : "Disabled"}
            </div>
          </div>

          <div className="mt-5 flex justify-end gap-3">
            <button
              onClick={onClose}
              className="rounded-md border border-border px-3 py-2 text-sm"
            >
              Cancel
            </button>
            <button
              disabled={!changed || parsedNetwork.ok === false}
              title={changed ? "Confirm posture change with PIN" : "No posture changes selected"}
              onClick={() => setConfirming(true)}
              className="rounded-md bg-primary px-3 py-2 text-sm text-[var(--on-primary)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {changed ? "Confirm with PIN" : "No changes"}
            </button>
          </div>
        </div>
      </div>

      {confirming && (
        <PinDialog
          title="Confirm security change"
          prompt="Enter your PIN to change the server security posture."
          error={error}
          onCancel={() => setConfirming(false)}
          onSubmit={(pin) => {
            void submitPin(pin);
          }}
        />
      )}
    </>
  );
}

function defaultNetworkPolicyForDeployment(
  mode: SecurityPosture["deploymentMode"],
): NetworkPolicy {
  if (mode === "desktop-permissive") return { mode: "host" };
  return { mode: "isolated" };
}

function formatAllowlist(
  rules: Extract<NetworkPolicy, { mode: "proxy-allowlist" }>["allow"],
): string {
  return rules.map((rule) => {
    const ports = rule.ports?.join(",") ?? "";
    if (rule.type === "domain") return `domain ${rule.host}${ports ? ` ${ports}` : ""}`;
    if (rule.type === "wildcard") return `wildcard ${rule.suffix}${ports ? ` ${ports}` : ""}`;
    return `cidr ${rule.cidr}${ports ? ` ${ports}` : ""}`;
  }).join("\n");
}

function parseNetworkPolicy(
  mode: NetworkMode,
  allowlistText: string,
): { ok: true; policy: NetworkPolicy } | { ok: false; error: string } {
  if (mode === "host" || mode === "isolated") return { ok: true, policy: { mode } };

  const allow: NetworkAllowRule[] = [];
  const lines = allowlistText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const [idx, line] of lines.entries()) {
    const parts = line.split(/\s+/);
    const [kind, value, portsRaw] = parts;
    if (parts.length > 3) {
      return { ok: false, error: `Allowlist line ${idx + 1}: too many columns` };
    }
    if (!kind || !value || !["domain", "wildcard", "cidr"].includes(kind)) {
      return { ok: false, error: `Allowlist line ${idx + 1}: expected "domain|wildcard|cidr value [ports]"` };
    }
    if (kind === "wildcard" && value === "*") {
      return { ok: false, error: `Allowlist line ${idx + 1}: wildcard must be a suffix like github.com` };
    }
    const ports = portsRaw
      ? parsePorts(portsRaw)
      : undefined;
    if (ports === null) {
      return { ok: false, error: `Allowlist line ${idx + 1}: invalid port list` };
    }
    if (kind === "domain") allow.push({ type: "domain", host: value, ...(ports ? { ports } : {}) });
    if (kind === "wildcard") allow.push({ type: "wildcard", suffix: value.replace(/^\*\./, ""), ...(ports ? { ports } : {}) });
    if (kind === "cidr") allow.push({ type: "cidr", cidr: value, ...(ports ? { ports } : {}) });
  }
  return { ok: true, policy: { mode: "proxy-allowlist", allow } };
}

function parsePorts(raw: string): number[] | null {
  if (!/^\d+(,\d+)*$/.test(raw)) return null;
  const ports = raw.split(",").map((p) => Number.parseInt(p, 10));
  if (ports.some((p) => !Number.isInteger(p) || p <= 0 || p > 65_535)) return null;
  return ports;
}
