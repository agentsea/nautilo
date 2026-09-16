import { useState } from "react";
import type { SecurityPosture } from "../../contexts/posture-context";
import { AuditLogViewer } from "./audit-log-viewer";
import { PostureEditModal } from "./posture-edit-modal";
import { useAuth } from "../../hooks/use-auth";
import { useCan } from "../../hooks/use-can";
import { PinDialog } from "../pin-dialog";

export type DesktopUncontainedHostCommandsControl = {
  readonly status: {
    readonly confirmed: boolean;
    readonly active: boolean;
    readonly eligible: boolean;
    readonly reason: string | null;
    readonly activatedAt: string | null;
  } | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly activate: (pin: string) => Promise<boolean>;
  readonly disable: () => Promise<void>;
};

type NetworkAllowRule = Extract<
  SecurityPosture["networkPolicy"],
  { mode: "proxy-allowlist" }
>["allow"][number];

export function PostureModal({
  posture,
  desktopUncontainedHostCommands,
  onClose,
  onRefresh,
}: {
  readonly posture: SecurityPosture;
  readonly desktopUncontainedHostCommands?: DesktopUncontainedHostCommandsControl;
  readonly onClose: () => void;
  readonly onRefresh: () => Promise<void>;
}) {
  const auth = useAuth();
  const can = useCan();
  const canViewAuditLog = can("view_audit_log");
  const [editing, setEditing] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const [activationPinOpen, setActivationPinOpen] = useState(false);
  const canManageServerPosture = can("manage_server_security");
  const canManageUncontainedHostCommands = can("manage_uncontained_host_commands");
  const canManage =
    canManageServerPosture || canManageUncontainedHostCommands;
  const desktopStatus = desktopUncontainedHostCommands?.status ?? null;
  const desktopActive = desktopStatus?.confirmed === true && desktopStatus.active;
  const desktopEligible = desktopStatus?.confirmed === true && desktopStatus.eligible;

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="security-posture-title"
          className="flex max-h-[min(760px,calc(100dvh-2rem))] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border-strong bg-background-panel shadow-xl"
        >
          <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div>
              <h2 id="security-posture-title" className="text-lg font-semibold">
                Security posture
              </h2>
              <p className="mt-1 text-sm text-foreground-muted">
                Current server-enforced sandbox and approval posture.
              </p>
            </div>
            <button type="button" onClick={onClose} className="text-foreground-muted hover:text-foreground">
              Close
            </button>
          </header>

          <div className="flex shrink-0 justify-end gap-3 border-b border-border px-5 py-3">
            {canViewAuditLog ? (
              <button
                onClick={() => setShowAudit((v) => !v)}
                className="rounded-md border border-border px-3 py-2 text-sm"
              >
                {showAudit ? "Hide audit log" : "View audit log"}
              </button>
            ) : null}
            <button
              disabled={!canManage}
              title={canManage ? "Change posture" : "Requires a server-security management capability"}
              onClick={() => setEditing(true)}
              className="rounded-md bg-primary px-3 py-2 text-sm text-[var(--on-primary)] disabled:opacity-50"
            >
              Change posture
            </button>
          </div>

          <div
            data-testid="security-posture-scroll-region"
            className="min-h-0 flex-1 overflow-y-auto p-5"
          >

          <div className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
            <PostureField label="Mode" value={posture.deploymentMode} />
            <PostureField label="Level" value={posture.securityLevel} />
            <PostureField label="Network" value={formatPostureNetworkPolicyLabel(posture)} />
            <PostureField label="Backend" value={backendLabel(posture)} />
            <PostureField
              label="Uncontained host commands"
              value={posture.allowUncontainedHostCommands ? "Enabled" : "Disabled"}
            />
            <PostureField label="Your role" value={auth.viewer.role} />
          </div>

          <section className="mt-5 rounded-md border border-border bg-background-element p-3 text-sm">
            <h3 className="font-semibold">Uncontained host commands</h3>
            <p className="mt-1 text-foreground-muted">
              This server-wide policy permits no one by itself. A separately
              granted Human must still activate it in their own Desktop session.
            </p>
          </section>

          {desktopUncontainedHostCommands ? (
            <section
              className={[
                "mt-5 rounded-md border p-4 text-sm",
                desktopActive
                  ? "border-[var(--error)]/60 bg-[var(--error)]/10"
                  : "border-[var(--warning)]/50 bg-[var(--warning)]/10",
              ].join(" ")}
              aria-labelledby="desktop-direct-mac-title"
            >
              <h3
                id="desktop-direct-mac-title"
                className={desktopActive ? "font-semibold text-[var(--error)]" : "font-semibold"}
              >
                {desktopActive ? "THIS DESKTOP IS UNCONTAINED" : "Direct Mac execution"}
              </h3>
              {desktopActive ? (
                <p className="mt-2 text-foreground-muted">
                  Genies can run shell commands directly as your macOS account across
                  everything it can access. Current Folder is not a security boundary.
                </p>
              ) : desktopEligible ? (
                <p className="mt-2 text-foreground-muted">
                  Available to you. This Desktop remains contained until you confirm
                  the uncontained-execution warning with your own PIN.
                </p>
              ) : (
                <p className="mt-2 text-foreground-muted">
                  Unavailable for this Desktop session. The server policy, your role,
                  your personal grant, and the live Desktop connection must all allow it.
                </p>
              )}
              {desktopUncontainedHostCommands.error ? (
                <p className="mt-2 text-[var(--error)]" role="alert">
                  {desktopUncontainedHostCommands.error}
                </p>
              ) : null}
              <div className="mt-3 flex justify-end">
                {desktopActive ? (
                  <button
                    type="button"
                    disabled={desktopUncontainedHostCommands.busy}
                    onClick={() => void desktopUncontainedHostCommands.disable()}
                    className="rounded-md border border-[var(--error)] px-3 py-2 font-medium text-[var(--error)] disabled:opacity-50"
                  >
                    Turn off immediately
                  </button>
                ) : desktopEligible ? (
                  <button
                    type="button"
                    disabled={desktopUncontainedHostCommands.busy}
                    onClick={() => setActivationPinOpen(true)}
                    className="rounded-md bg-primary px-3 py-2 font-medium text-[var(--on-primary)] disabled:opacity-50"
                  >
                    Enable for this session
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}

          <NetworkPolicySummary posture={posture} />
          <PathList title="Writable paths" paths={posture.writablePaths} />
          <PathList title="Read-only paths" paths={posture.readOnlyPaths} />

          <section className="mt-5">
            <h3 className="text-sm font-semibold">Your capabilities</h3>
            {posture.capabilities.length === 0 ? (
              <p className="mt-2 text-sm text-foreground-muted">No security-management capabilities.</p>
            ) : (
              <ul className="mt-2 flex flex-wrap gap-2">
                {posture.capabilities.map((cap) => (
                  <li key={cap} className="rounded-full bg-background-element px-2 py-0.5 text-xs">
                    {cap}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {canViewAuditLog && showAudit && (
            <section className="mt-5">
              <h3 className="mb-2 text-sm font-semibold">Recent audit log</h3>
              <AuditLogViewer />
            </section>
          )}

          </div>
        </section>
      </div>

      {editing && (
        <PostureEditModal
          posture={posture}
          canManageServerSecurity={canManageServerPosture}
          canManageUncontainedHostCommands={canManageUncontainedHostCommands}
          onClose={() => setEditing(false)}
          onUpdated={onRefresh}
        />
      )}
      {activationPinOpen && desktopUncontainedHostCommands ? (
        <PinDialog
          title="Enable Direct Mac execution"
          prompt="Enter your own PIN. Genies may run shell commands directly as your macOS account across everything it can access; Current Folder is not a boundary."
          error={desktopUncontainedHostCommands.error ?? undefined}
          onSubmit={(pin) => {
            void desktopUncontainedHostCommands.activate(pin).then((activated) => {
              if (activated) setActivationPinOpen(false);
            });
          }}
          onCancel={() => {
            if (!desktopUncontainedHostCommands.busy) setActivationPinOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function PostureField({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-md border border-border bg-background-element p-3">
      <div className="text-xs uppercase tracking-wide text-foreground-muted">{label}</div>
      <div className="mt-1 font-mono text-sm">{value}</div>
    </div>
  );
}

function PathList({ title, paths }: { readonly title: string; readonly paths: readonly string[] }) {
  return (
    <section className="mt-5">
      <h3 className="text-sm font-semibold">{title}</h3>
      {paths.length === 0 ? (
        <p className="mt-2 text-sm text-foreground-muted">None</p>
      ) : (
        <ul className="mt-2 grid gap-1">
          {paths.map((path) => (
            <li key={path} className="truncate rounded bg-background-element px-2 py-1 font-mono text-xs" title={path}>
              {path}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NetworkPolicySummary({ posture }: { readonly posture: SecurityPosture }) {
  const policy = posture.networkPolicy;
  const rules = policy.mode === "proxy-allowlist" ? policy.allow : [];
  return (
    <section className="mt-5">
      <h3 className="text-sm font-semibold">Network access</h3>
      <p className="mt-1 text-sm text-foreground-muted">
        {formatPostureNetworkPolicyDescription(posture)}
      </p>
      {rules.length > 0 && (
        <ul className="mt-2 grid gap-1">
          {rules.map((rule, index) => (
            <li
              key={`${networkRuleLabel(rule)}-${index}`}
              className="truncate rounded bg-background-element px-2 py-1 font-mono text-xs"
              title={networkRuleLabel(rule)}
            >
              {networkRuleLabel(rule)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function backendLabel(posture: SecurityPosture): string {
  if (posture.backend.kind === "bubblewrap") {
    return `bubblewrap (proc=${posture.backend.procSupported === true ? "yes" : "no"})`;
  }
  return posture.backend.kind;
}

/** Inline + modal — keep wording in sync. */
function formatPostureNetworkPolicyLabel(posture: SecurityPosture): string {
  const policy = posture.networkPolicy;
  if (policy.mode !== "proxy-allowlist") return policy.mode;
  return `${policy.mode} (${policy.allow.length} rule${policy.allow.length === 1 ? "" : "s"})`;
}

/** One-line explanation for the current network policy. */
function formatPostureNetworkPolicyDescription(
  posture: SecurityPosture,
): string {
  const policy = posture.networkPolicy;
  if (policy.mode === "host") return "Host networking is available to sandboxed tools.";
  if (policy.mode === "isolated") return "Outbound network is blocked by the sandbox.";
  if (policy.allow.length === 0) {
    return "Only the local proxy is reachable; no outbound hosts are currently allowlisted.";
  }
  return "Sandboxed tools must use the local proxy; only these hosts/ports are allowlisted.";
}

function networkRuleLabel(rule: NetworkAllowRule): string {
  const ports = rule.ports?.join(",") ?? "443";
  if (rule.type === "domain") return `${rule.host}:${ports}`;
  if (rule.type === "wildcard") return `*.${rule.suffix}:${ports}`;
  return `${rule.cidr}:${ports}`;
}
