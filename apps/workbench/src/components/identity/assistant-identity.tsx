import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Square, Volume2, VolumeX } from "lucide-react";
import { SHELL_AGENT_NAME, type AgentProfileResponse } from "@nautilo/types";
import { useVoiceControls, type VoiceControls } from "../../adapters/runtime-contexts";
import { useProfile } from "../../hooks/use-profile";
import { useCan } from "../../hooks/use-can";
import { useViewerAffordances } from "../../hooks/use-viewer-affordances";
import { extractSoulEssence, SOUL_FALLBACK_PROMPT } from "../soul-extract";
import { clampSoulPreview } from "../soul-preview";
import { SubagentDock } from "../../modes/rooms/subagents/SubagentDock";

export type AssistantIdentityVariant = "badge" | "panel" | "inline" | "settings-row";

export function AssistantIdentity({
  variant,
  showSubagentDock = true,
}: {
  variant: AssistantIdentityVariant;
  showSubagentDock?: boolean;
}) {
  const { response, agent, avatarSrc, avatarLoading, loading } = useProfile();
  const name = agent?.name ?? SHELL_AGENT_NAME;

  if (variant === "inline") return <>{name}</>;
  if (variant === "badge") return <IdentityBadge name={name} role={response?.viewerRole ?? "guest"} />;
  if (variant === "settings-row") return <SettingsIdentity name={name} avatarSrc={avatarSrc} avatarLoading={avatarLoading} />;
  return (
    <ConnectedPanelIdentity
      response={response}
      name={name}
      avatarSrc={avatarSrc}
      avatarLoading={avatarLoading}
      loading={loading}
      showSubagentDock={showSubagentDock}
    />
  );
}

type PanelVoiceControls = Pick<VoiceControls, "enabled" | "playing" | "toggle" | "stop">;

function ConnectedPanelIdentity(
  props: Omit<Parameters<typeof PanelIdentity>[0], "canToggleSessionSpeech" | "voice">,
) {
  const voice = useVoiceControls();
  const { canToggleSessionSpeech } = useViewerAffordances();
  return (
    <PanelIdentity
      {...props}
      voice={voice}
      canToggleSessionSpeech={canToggleSessionSpeech}
    />
  );
}

function IdentityBadge({ name, role }: { name: string; role: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || "·";
  return (
    <div
      role="img"
      aria-label={`${role}: ${name}`}
      title={`${role}: ${name}`}
      className="flex h-6 w-6 items-center justify-center rounded-full bg-foreground-muted/20 text-[10px] font-semibold text-foreground-muted"
    >
      {initial}
    </div>
  );
}

function SettingsIdentity({
  name,
  avatarSrc,
  avatarLoading,
}: {
  name: string;
  avatarSrc: string;
  avatarLoading: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      {/*
        D243 — when the avatar is mid-fetch (`avatarLoading`), dim the
        SHELL/old object URL slightly to give a passive "refreshing"
        cue. `transition-opacity` smooths the swap when the new
        thumbnail bytes arrive and the object URL updates.
      */}
      <img
        src={avatarSrc}
        alt={name}
        aria-busy={avatarLoading}
        className={`h-10 w-10 rounded-lg object-cover transition-opacity duration-150 ${
          avatarLoading ? "opacity-60" : "opacity-100"
        }`}
      />
      <span className="text-sm font-medium text-foreground">{name}</span>
    </div>
  );
}

/**
 * Exported for focused identity-panel regression tests. Public callers should
 * use `<AssistantIdentity variant="panel" />`.
 */
export function PanelIdentity({
  response,
  name,
  avatarSrc,
  avatarLoading = false,
  loading,
  showSubagentDock = true,
  canToggleSessionSpeech = false,
  voice,
}: {
  response: AgentProfileResponse | null;
  name: string;
  avatarSrc: string;
  /**
   * D243 — when true, the avatar fetch is in flight. Renders the same
   * `<img>` with a brief dim so cold-load and avatar-change refreshes
   * feel intentional instead of staring at the SHELL placeholder
   * silently. Defaults to false for direct test and non-wrapper callers.
   */
  avatarLoading?: boolean;
  loading: boolean;
  /** Activity belongs to Room work, never to management-route side panels. */
  showSubagentDock?: boolean;
  /** Runtime affordance and state are injected by the connected panel wrapper. */
  canToggleSessionSpeech?: boolean;
  voice?: PanelVoiceControls;
}) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const can = useCan();
  const isOwner = response?.viewerRole === "owner";
  // M129 / AR-5 — the soul preview is visible for your OWN agent
  // (per-agent `viewerRole === "owner"`) or to a `manage_agents` holder
  // (editing others' agents). Soul bytes are only present in the owner
  // projection today, so the cap branch is forward-compatible with D225.
  const canSeeSoul = isOwner || can("manage_agents");
  const soulFile = response?.viewerRole === "owner" ? response.agent.soulFile : null;
  const essence = useMemo(() => extractSoulEssence(soulFile), [soulFile]);
  const soulPreview = useMemo(() => clampSoulPreview(essence), [essence]);

  useEffect(() => {
    setAvatarFailed(false);
  }, [avatarSrc]);

  if (loading) {
    return <div className="p-4 text-sm text-foreground-muted">Loading profile…</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-10 py-6">
        <div className="flex items-center justify-center gap-4">
          {!avatarFailed ? (
            <img
              src={avatarSrc}
              alt={name}
              aria-busy={avatarLoading}
              onError={() => setAvatarFailed(true)}
              className={`h-20 w-20 shrink-0 rounded-2xl object-cover transition-opacity duration-150 ${
                avatarLoading ? "opacity-70" : "opacity-100"
              }`}
            />
          ) : (
            <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl bg-background-element text-3xl">
              🐚
            </div>
          )}
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-foreground">{name}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-foreground-muted">
              <span className="flex items-center gap-2">
                <span aria-hidden className="text-xs text-online">●</span>
                Online
              </span>
              {canToggleSessionSpeech && voice ? (
                <button
                  type="button"
                  onClick={voice.playing ? voice.stop : voice.toggle}
                  aria-label={
                    voice.playing
                      ? "Stop Genie voice playback"
                      : `Turn Genie voice playback ${voice.enabled ? "off" : "on"}`
                  }
                  aria-pressed={voice.playing ? undefined : voice.enabled}
                  className={`inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors ${
                    voice.playing || voice.enabled
                      ? "bg-online/15 text-online hover:bg-online/20"
                      : "bg-background-element text-foreground-muted hover:text-foreground"
                  }`}
                >
                  {voice.playing ? (
                    <Square aria-hidden className="h-3 w-3 fill-current" />
                  ) : voice.enabled ? (
                    <Volume2 aria-hidden className="h-3.5 w-3.5" />
                  ) : (
                    <VolumeX aria-hidden className="h-3.5 w-3.5" />
                  )}
                  {voice.playing ? "Stop speaking" : voice.enabled ? "Voice on" : "Voice off"}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div className="shrink-0 border-t border-border/70 px-5 py-5">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-foreground-dim">
          Soul
        </h3>
        {canSeeSoul && soulPreview ? (
          <p className="text-sm leading-relaxed text-foreground-muted">{soulPreview}</p>
        ) : (
          <p className="text-sm italic leading-relaxed text-foreground-dim">
            {canSeeSoul
              ? SOUL_FALLBACK_PROMPT
              : "Your private soul file is hidden while you're browsing as Guest. Genie is here in generic mode until you verify your identity."}
          </p>
        )}
        {canSeeSoul ? (
          <Link
            to="/settings#my-agents"
            className="mt-4 flex items-center justify-between rounded-md bg-background-element px-4 py-2.5 text-sm font-medium text-foreground-muted transition-colors hover:text-foreground"
          >
            <span className="truncate">Customize {name}</span>
            <span aria-hidden className="ml-2 shrink-0">→</span>
          </Link>
        ) : null}
      </div>

      {showSubagentDock ? <SubagentDock /> : null}
    </div>
  );
}
