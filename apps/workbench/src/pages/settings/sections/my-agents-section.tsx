import { useState } from "react";
import type { AgentProfileResponse, OwnedAgentSummary } from "@nautilo/types";
import { AgentPhotoLibraryModal } from "../../../components/agent-photo-library/agent-photo-library-modal";
import { formatAgentDisplayName } from "../../../components/identity/agent-display-name";
import { useProfile } from "../../../hooks/use-profile";
import { GenieBackupRestore } from "./genie-backup-restore";
import { ProfileSection } from "./profile-section";
import { ModelSection } from "./model-section";
import { FallbackSection } from "./fallback-section";

/**
 * Read `ownedAgents` from the AgentProfileResponse. Owner / household /
 * teammate viewer roles include the field (B2 contract); guest / stranger
 * shells omit it deliberately. Always returns a stable empty array when
 * absent so the UI renders the empty-state.
 */
function readOwnedAgents(
  response: AgentProfileResponse | null,
): ReadonlyArray<OwnedAgentSummary> {
  if (!response) return [];
  return "ownedAgents" in response ? response.ownedAgents : [];
}

/**
 * Settings → Profile → My Agents.
 * Renders the canonical Agent Profile editor only for Agents the viewer owns.
 */
export function MyAgentsSection({
  showProviderKeyStatus = true,
}: {
  showProviderKeyStatus?: boolean;
}) {
  const { response, loading, error, refresh } = useProfile();
  const [photoLibraryOpen, setPhotoLibraryOpen] = useState(false);
  const ownedAgents = readOwnedAgents(response);

  return (
    <>
      <div
        id="my-agents"
        data-testid="my-agents-section"
        className="rounded-lg border border-border bg-background-panel"
      >
        <header className="border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold">My Agents</h2>
          <p className="mt-1 text-xs text-foreground-muted">
            Agents you own on this Server. Changes here mutate your Agent — not anyone else&apos;s.
          </p>
        </header>
        <div className="px-5 py-4">
        {error ? (
          <p className="text-sm text-[var(--error)]">
            Could not load Agents: {error.message}
          </p>
        ) : loading ? (
          <p className="text-sm text-foreground-muted">Loading…</p>
        ) : ownedAgents.length === 0 ? (
          <p
            data-testid="my-agents-empty-state"
            className="text-sm text-foreground-muted"
          >
            You don&apos;t own any Agents on this Server yet. Multi-Agent support is coming
            soon.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {ownedAgents.map((agent, index) => {
              const displayName = formatAgentDisplayName(agent, ownedAgents);
              return (
                <div
                  key={agent.agentId}
                  data-testid={`my-agent-card-${agent.agentId}`}
                  className="rounded-md border border-border/60 bg-background-element/40"
                >
                  <div className="border-b border-border/40 px-4 py-3">
                    <h3 className="text-sm font-medium text-foreground">
                      My Agent: {displayName}
                    </h3>
                    <p className="mt-0.5 text-xs text-foreground-muted">
                      This changes {displayName} (your Agent) — profile, model, fallback, voice,
                      and avatar.
                    </p>
                  </div>
                  {index === 0 ? (
                    <div className="p-4 pt-3">
                      <ProfileSection onOpenPhotoLibrary={() => setPhotoLibraryOpen(true)} />
                      <GenieBackupRestore
                        onRestored={async () => {
                          await refresh();
                        }}
                      />
                      <div className="mt-4 flex flex-col gap-4 border-t border-border/40 pt-4">
                        <ModelSection showProviderKeyStatus={showProviderKeyStatus} />
                        <FallbackSection />
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
            {ownedAgents.length > 1 ? (
              <p
                data-testid="my-agents-multi-hint"
                className="text-xs text-foreground-muted"
              >
                Multi-Agent editing is coming soon — only your first owned Agent is editable in
                this release.
              </p>
            ) : null}
          </div>
        )}
        </div>
      </div>
      <AgentPhotoLibraryModal
        open={photoLibraryOpen}
        onClose={() => setPhotoLibraryOpen(false)}
        onChanged={async () => {
          await refresh();
          window.dispatchEvent(new Event("nautilo:profile-changed"));
        }}
      />
    </>
  );
}
