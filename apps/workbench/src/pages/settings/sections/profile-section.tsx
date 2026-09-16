import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import {
  DEFAULT_VOICE_KEY,
  HANDLE_INVALID_MESSAGE,
  PROFILE_AVATAR_URL,
  isValidHandle,
  normalizeHandle,
  type VoiceRef,
} from "@nautilo/types";
import { workbenchFetch } from "../../../lib/admission-fetch";
import { apiClient } from "../../../lib/api";
import { desktopAPI, isDesktop } from "../../../lib/desktop";
import { genieCustomizationPath } from "../../../lib/genie-soft-prompt";
import { useAuth } from "../../../hooks/use-auth";
import { useCan } from "../../../hooks/use-can";
import { useProfile } from "../../../hooks/use-profile";
import { AssistantIdentity } from "../../../components/identity/assistant-identity";
import {
  genieSampleTextForLanguage,
  VoiceCatalogModal,
} from "../../../components/voice-catalog/voice-catalog-modal";
import {
  Button,
  FieldRow,
  GuestPlaceholder,
  SectionCard,
  StatusPill,
  TextInput,
} from "../ui";

type SaveState = "idle" | "saving" | "saved" | { error: string };

type VoiceCatalogIntent =
  | { kind: "add-language" }
  | { kind: "change-primary" }
  | { kind: "change-language"; lang: string };

function languageDisplayLabel(lang: string): string {
  try {
    const dn = new Intl.DisplayNames(["en"], { type: "language" });
    const name = dn.of(lang.split("-")[0]);
    return name ? `${name} (${lang})` : lang;
  } catch {
    return lang;
  }
}

function voiceRosterDisplayName(ref: VoiceRef | undefined): string {
  const raw = ref?.voiceName?.trim() || ref?.voiceId || "Not set";
  return raw.split(/\s+-\s+/, 1)[0] || raw;
}

function VoiceRosterAction({
  children,
  onClick,
  disabled,
  ariaLabel,
  title,
  variant = "secondary",
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  ariaLabel?: string;
  title?: string;
  variant?: "secondary" | "ghost";
}) {
  const style =
    variant === "ghost"
      ? "bg-transparent text-foreground-muted hover:bg-background-element hover:text-foreground"
      : "border border-border bg-background-element text-foreground hover:border-border-strong";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      title={title}
      className={[
        "inline-flex h-8 items-center justify-center rounded-md px-2 text-xs font-medium transition-[color,transform,opacity] duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100",
        style,
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function VoiceRosterTextAction({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="text-xs font-medium text-foreground-muted underline-offset-2 hover:text-foreground hover:underline disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function avatarDownloadFilename(name: string, mimeType: string): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "agent";
  const ext =
    mimeType === "image/jpeg"
      ? "jpg"
      : mimeType === "image/webp"
        ? "webp"
        : mimeType === "image/svg+xml"
          ? "svg"
          : "png";
  return `${base}-avatar.${ext}`;
}

/**
 * Lightweight audio previewer. One <audio> element, re-pointed per click so we
 * never layer overlapping samples. Stops on unmount.
 */
function useAudioPreview() {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [playingUrl, setPlayingUrl] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (ref.current) {
        ref.current.pause();
        ref.current.src = "";
      }
    };
  }, []);

  const play = useCallback((url: string) => {
    if (!ref.current) {
      ref.current = new Audio();
      ref.current.addEventListener("ended", () => setPlayingUrl(null));
      ref.current.addEventListener("error", () => setPlayingUrl(null));
    }
    ref.current.pause();
    ref.current.src = url;
    setPlayingUrl(url);
    void ref.current.play().catch(() => setPlayingUrl(null));
  }, []);

  const stop = useCallback(() => {
    if (ref.current) {
      ref.current.pause();
      ref.current.currentTime = 0;
    }
    setPlayingUrl(null);
  }, []);

  return { play, stop, playingUrl } as const;
}

export function ProfileSection({ onOpenPhotoLibrary }: { onOpenPhotoLibrary: () => void }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const can = useCan();
  const { response, loading, error, refresh, avatarSrc } = useProfile();
  const profile = response?.viewerRole === "owner" ? response.agent : null;
  const primaryVoice = profile?.voices[DEFAULT_VOICE_KEY];
  // M129 / AR-5 — editing your OWN Agent Profile is unconditional (the
  // per-agent `viewerRole === "owner"` IS the ownership signal); editing
  // OTHERS' agents requires `manage_agents`. This replaces the old
  // server-wide `auth.viewer.role === "owner"` gate, which wrongly
  // blocked a non-owner server role from editing their own Agent. Voice
  // selection lives inside this same own-agent surface, so it is
  // inherently personal (owner's decision: voice is personal when the
  // Agent is yours) — no separate voice capability gate is needed.
  const enabled = response?.viewerRole === "owner" || can("manage_agents");
  const preview = useAudioPreview();

  const [draftName, setDraftName] = useState<string>("");
  const [nameSave, setNameSave] = useState<SaveState>("idle");
  const [draftHandle, setDraftHandle] = useState<string>("");
  const [handleSave, setHandleSave] = useState<SaveState>("idle");
  const [voiceSave, setVoiceSave] = useState<SaveState>("idle");
  const [avatarDownload, setAvatarDownload] = useState<SaveState>("idle");
  const [catalogIntent, setCatalogIntent] = useState<VoiceCatalogIntent | null>(null);

  // Sync draft name once profile loads. Don't clobber user edits.
  const syncedOnceRef = useRef(false);
  useEffect(() => {
    if (profile && !syncedOnceRef.current) {
      setDraftName(profile.name);
      setDraftHandle(profile.handle ?? "");
      syncedOnceRef.current = true;
    }
  }, [profile]);

  // D091 Phase 3 — listen for `onboarding:completed` pushes from
  // main so a re-trigger of the wizard refreshes our local profile
  // snapshot. Main fires this on BOTH success and cancel paths,
  // so we always refetch — cheap, and on cancel it's a no-op
  // since nothing changed server-side.
  const refetchProfile = useCallback(async () => {
    if (!enabled) return;
    try {
      await refresh();
      window.dispatchEvent(new Event("nautilo:profile-changed"));
      // Reset draft sync so the new name is picked up.
      syncedOnceRef.current = false;
    } catch {
      // Silent fallback — Settings UI surfaces fresh load errors
      // via the canonical profile hook on next mount.
    }
  }, [enabled, refresh]);

  useEffect(() => {
    if (!isDesktop || !desktopAPI) return undefined;
    const unsubscribe = desktopAPI.onboarding.onCompleted(() => {
      void refetchProfile();
    });
    return unsubscribe;
  }, [refetchProfile]);

  const openCustomization = useCallback(async (startAt?: "personality" | "avatar") => {
    if (!isDesktop || !desktopAPI) {
      void navigate(genieCustomizationPath(startAt));
      return;
    }
    // Forward the workbench Logto access token + active theme to main
    // so the wizard inherits both (see `NautiloDesktopAPI.onboarding`).
    let token: string | null = null;
    let theme: "light" | "dark" | null = null;
    try {
      token = await auth.session.getAccessToken();
      const storedTheme = localStorage.getItem("nautilo-theme");
      theme = storedTheme === "light" || storedTheme === "dark" ? storedTheme : null;
    } catch {
      /* same fallthrough as before */
    }
    void desktopAPI.onboarding.open(
      token,
      theme,
      startAt ? { startAt } : undefined,
    );
  }, [auth.session, navigate]);

  const openSoulEditor = useCallback(() => {
    void openCustomization("personality");
  }, [openCustomization]);

  const saveName = async () => {
    if (!profile) return;
    const next = draftName.trim();
    if (!next) {
      setNameSave({ error: "Name cannot be empty" });
      return;
    }
    if (next === profile.name) {
      setNameSave("saved");
      return;
    }
    setNameSave("saving");
    try {
      await apiClient.updateProfile({ name: next });
      await refresh();
      setNameSave("saved");
      window.dispatchEvent(new Event("nautilo:profile-changed"));
    } catch (e) {
      setNameSave({
        error: e instanceof Error ? e.message : "Save failed",
      });
    }
  };

  const saveHandle = async () => {
    if (!profile) return;
    const next = normalizeHandle(draftHandle);
    if (!isValidHandle(next)) {
      setHandleSave({ error: HANDLE_INVALID_MESSAGE });
      return;
    }
    if (next === profile.handle) {
      setHandleSave("saved");
      return;
    }
    setHandleSave("saving");
    try {
      await apiClient.updateAgentHandle(next);
      await refresh();
      setHandleSave("saved");
      window.dispatchEvent(new Event("nautilo:profile-changed"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      const taken = /handle_taken|\b409\b/.test(msg);
      setHandleSave({
        error: taken ? "That handle is taken." : (e instanceof Error ? e.message : "Save failed"),
      });
    }
  };

  const languageVoices = useMemo(() => {
    if (!profile) return [] as Array<[string, VoiceRef]>;
    return Object.entries(profile.voices)
      .filter(([key]) => key !== DEFAULT_VOICE_KEY)
      .sort(([a], [b]) => a.localeCompare(b));
  }, [profile]);

  const previewAssignedVoice = useCallback(
    async (voiceId: string, lang: string) => {
      try {
        const blob = await apiClient.previewVoice(voiceId, {
          text: genieSampleTextForLanguage(lang),
        });
        preview.play(URL.createObjectURL(blob));
      } catch {
        /* preview optional */
      }
    },
    [preview],
  );

  const saveVoiceMutation = async (fn: () => Promise<void>) => {
    setVoiceSave("saving");
    try {
      await fn();
      await refresh();
      setVoiceSave("saved");
      window.dispatchEvent(new Event("nautilo:profile-changed"));
    } catch (e) {
      setVoiceSave({
        error: e instanceof Error ? e.message : "Save failed",
      });
    }
  };

  const makePrimaryFromLanguage = async (lang: string) => {
    if (!profile) return;
    const ref = profile.voices[lang];
    if (!ref) return;
    await saveVoiceMutation(async () => {
      await apiClient.upsertVoiceAssignment(DEFAULT_VOICE_KEY, ref);
    });
  };

  const removeLanguageVoice = async (lang: string) => {
    await saveVoiceMutation(async () => {
      await apiClient.removeVoiceAssignment(lang);
    });
  };

  const downloadAvatar = async () => {
    if (!profile) return;
    setAvatarDownload("saving");
    try {
      // D243 — `avatarSrc` resolves to the in-memory thumbnail object URL
      // (or the SHELL data URL). For the Download button we want the
      // cherished 1024² original whenever one exists, so fetch the
      // canonical avatar route with `?size=full`. The server falls back
      // to the same thumbnail for `kind: "uploaded"` avatars (which only
      // ever have one variant on disk) and to SHELL when the viewer has
      // no avatar, matching what the panel previously showed.
      const token = await auth.session.getAccessToken();
      const res = await workbenchFetch(`${PROFILE_AVATAR_URL}?size=full`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`Failed to read avatar (${res.status})`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = avatarDownloadFilename(profile.name, blob.type);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
      setAvatarDownload("saved");
    } catch (e) {
      setAvatarDownload({
        error: e instanceof Error ? e.message : "Download failed",
      });
    }
  };

  const catalogModalProps = useMemo(() => {
    if (!catalogIntent) return null;
    switch (catalogIntent.kind) {
      case "add-language":
        return {
          title: "Add a language voice",
          roleAtAssign: true as const,
          initialLanguage: null,
          defaultAssignRole: undefined,
        };
      case "change-primary":
        return {
          title: "Change primary voice",
          roleAtAssign: true as const,
          initialLanguage: profile?.language ?? null,
          defaultAssignRole: DEFAULT_VOICE_KEY,
        };
      case "change-language":
        return {
          title: `Change ${languageDisplayLabel(catalogIntent.lang)} voice`,
          roleAtAssign: true as const,
          initialLanguage: catalogIntent.lang,
          defaultAssignRole: catalogIntent.lang,
        };
    }
  }, [catalogIntent, profile?.language]);

  if (!enabled) {
    return (
      <SectionCard
        id="profile"
        title="Profile"
        description="Your assistant's identity and voice."
      >
        <GuestPlaceholder what="The Agent Profile" />
      </SectionCard>
    );
  }

  return (
    <SectionCard
      id="profile"
      title="Profile"
      description="Your assistant's identity and voice."
    >
      {error ? (
        <p className="text-sm text-[var(--error)]">
          Could not load profile: {error.message}
        </p>
      ) : loading || !profile ? (
        <p className="text-sm text-foreground-muted">Loading…</p>
      ) : (
        <>
          <FieldRow
            label="Assistant identity"
            hint="The Agent Profile shown throughout Nautilo."
          >
            <AssistantIdentity variant="settings-row" />
          </FieldRow>
          <FieldRow
            label="Name"
            htmlFor="settings-profile-name"
            hint="What the assistant calls itself. Used in the UI, voice introductions, and soul file."
          >
            <div className="flex items-center gap-2">
              <TextInput
                id="settings-profile-name"
                value={draftName}
                onChange={(v) => {
                  setDraftName(v);
                  if (nameSave !== "idle") setNameSave("idle");
                }}
                placeholder="Genie"
                autoComplete="off"
              />
              <Button
                variant="primary"
                onClick={() => {
                  void saveName();
                }}
                loading={nameSave === "saving"}
                disabled={
                  draftName.trim() === profile.name || draftName.trim() === ""
                }
              >
                Save
              </Button>
              {nameSave === "saved" ? (
                <StatusPill tone="ok">Saved</StatusPill>
              ) : typeof nameSave === "object" ? (
                <StatusPill tone="error">{nameSave.error}</StatusPill>
              ) : null}
            </div>
          </FieldRow>

          <FieldRow
            label="Handle"
            htmlFor="settings-profile-handle"
            hint="Your Agent's @handle on this Server. Editing it here stops the handle from changing when you rename the Agent."
          >
            <div className="flex items-center gap-2">
              <span className="text-foreground-muted">@</span>
              <TextInput
                id="settings-profile-handle"
                value={draftHandle}
                onChange={(v) => {
                  setDraftHandle(v);
                  if (handleSave !== "idle") setHandleSave("idle");
                }}
                placeholder="genie"
                autoComplete="off"
              />
              <Button
                variant="primary"
                onClick={() => {
                  void saveHandle();
                }}
                loading={handleSave === "saving"}
                disabled={
                  normalizeHandle(draftHandle) === profile.handle ||
                  !isValidHandle(normalizeHandle(draftHandle))
                }
              >
                Save
              </Button>
              {handleSave === "saved" ? (
                <StatusPill tone="ok">Saved</StatusPill>
              ) : typeof handleSave === "object" ? (
                <StatusPill tone="error">{handleSave.error}</StatusPill>
              ) : null}
            </div>
          </FieldRow>

          <FieldRow
            label="Look"
            hint="Your Agent's avatar — shown in chat, the panel, and Settings."
          >
            <div className="flex flex-wrap items-center gap-3">
              <img
                src={avatarSrc}
                alt={profile.name}
                className="h-16 w-16 rounded-lg object-cover"
              />
              <Button
                variant="primary"
                onClick={onOpenPhotoLibrary}
                disabled={!enabled}
              >
                Change photo
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  void downloadAvatar();
                }}
                loading={avatarDownload === "saving"}
              >
                Download image
              </Button>
              {avatarDownload === "saved" ? (
                <StatusPill tone="ok">Downloaded</StatusPill>
              ) : typeof avatarDownload === "object" ? (
                <StatusPill tone="error">{avatarDownload.error}</StatusPill>
              ) : null}
              <p className="basis-full text-xs text-foreground-muted">
                Browse saved photos, presets, uploads, generation, and Recently deleted.
              </p>
            </div>
          </FieldRow>
          <FieldRow
            label="Soul"
            hint="The full soul file that shapes the Agent's tone, boundaries, and defaults."
          >
            <div id="profile-soul" className="scroll-mt-24">
              <SoulFileViewer
                soulFile={profile.soulFile}
                onEditInstructions={openSoulEditor}
              />
            </div>
          </FieldRow>

          {/* D091 / D510 — re-trigger the unified customization journey.
              Owner screen's PIN re-enrollment
              is unreachable in re-trigger mode by design (see flows.md
              "PIN trap"); this surface is for personality / voice /
              avatar / language tweaks, not security mutations. Sits
              between Name and Voice because the wizard is the
              "personality" axis of the profile, slotted between the
              identity row (Name) and the per-channel knobs (Voice). */}
          <div className="grid grid-cols-[1fr_auto] items-start gap-x-4 border-b border-border/40 py-3 last:border-b-0 last:pb-0 first:pt-0">
            <div className="min-w-0">
              <label className="block text-sm font-medium text-foreground">
                Personalize your Genie
              </label>
              <p className="mt-1 text-xs text-foreground-muted">
                Update personality, voice, avatar, or language. Your existing values
                are pre-filled; PIN never changes here.
              </p>
              {!enabled ? (
                <p className="mt-2 text-xs text-[var(--warning)]">
                  You don&apos;t have permission to edit this Agent Profile.
                </p>
              ) : null}
            </div>
            <Button
              variant="primary"
              onClick={() => {
                void openCustomization();
              }}
              disabled={!enabled}
            >
              Customize Genie →
            </Button>
          </div>

          {/*
           * Session voice on/off stays in the conversation and navigation
           * surfaces shared by all chat-capable viewers. Voice *selection*
           * (below) remains owner-only Agent configuration.
           */}

          <FieldRow
            label="Voices"
            hint={
              <>
                Genie speaks in her primary voice and switches to a language voice
                when she speaks that language. Browse the catalog to assign
                ElevenLabs voices. Verification badges show provider language metadata.
              </>
            }
          >
            <div className="flex flex-col gap-3" data-testid="voice-roster">
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground-dim">
                  Primary
                </p>
                <div
                  className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background-element px-3 py-2"
                  data-testid="voice-roster-primary"
                >
                  <span className="text-sm" aria-hidden>
                    ★
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">
                      {voiceRosterDisplayName(primaryVoice)}
                    </p>
                    <p className="text-xs text-foreground-muted">
                      {languageDisplayLabel(profile.language)} · primary
                    </p>
                  </div>
                  {primaryVoice?.voiceId ? (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        void previewAssignedVoice(primaryVoice.voiceId, profile.language);
                      }}
                      ariaLabel="Preview primary voice"
                    >
                      ▶ Preview
                    </Button>
                  ) : null}
                  <Button
                    variant="secondary"
                    onClick={() => setCatalogIntent({ kind: "change-primary" })}
                  >
                    Change
                  </Button>
                </div>
              </div>

              {languageVoices.length > 0 ? (
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground-dim">
                    Language voices
                  </p>
                  <ul className="flex flex-col gap-2">
                    {languageVoices.map(([lang, ref]) => (
                      <li
                        key={lang}
                        data-testid={`voice-roster-lang-${lang}`}
                        className="rounded-md border border-border bg-background-element px-3 py-2"
                      >
                        <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-foreground" title={ref.voiceName ?? ref.voiceId}>
                              {voiceRosterDisplayName(ref)}
                            </p>
                            <p className="text-xs text-foreground-muted">
                              {languageDisplayLabel(lang)}
                            </p>
                          </div>
                          <VoiceRosterAction
                            variant="ghost"
                            onClick={() => {
                              void previewAssignedVoice(ref.voiceId, lang);
                            }}
                            ariaLabel={`Preview ${languageDisplayLabel(lang)} voice`}
                            title={`Preview ${languageDisplayLabel(lang)} voice`}
                          >
                            ▶
                          </VoiceRosterAction>
                          <VoiceRosterAction
                            onClick={() =>
                              setCatalogIntent({ kind: "change-language", lang })
                            }
                          >
                            Change
                          </VoiceRosterAction>
                        </div>
                        <div className="mt-1 flex justify-end gap-3">
                          <VoiceRosterTextAction
                            onClick={() => {
                              void makePrimaryFromLanguage(lang);
                            }}
                            disabled={voiceSave === "saving"}
                          >
                            Make primary
                          </VoiceRosterTextAction>
                          <VoiceRosterTextAction
                            onClick={() => {
                              void removeLanguageVoice(lang);
                            }}
                            disabled={voiceSave === "saving"}
                          >
                            Remove
                          </VoiceRosterTextAction>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <Button
                variant="secondary"
                data-testid="voice-roster-add-language"
                onClick={() => setCatalogIntent({ kind: "add-language" })}
              >
                + Add a language voice
              </Button>
            </div>

            {catalogModalProps ? (
              <VoiceCatalogModal
                open
                title={catalogModalProps.title}
                roleAtAssign={catalogModalProps.roleAtAssign}
                initialLanguage={catalogModalProps.initialLanguage}
                defaultAssignRole={catalogModalProps.defaultAssignRole}
                onClose={() => setCatalogIntent(null)}
                onAssigned={async () => {
                  setCatalogIntent(null);
                  await refresh();
                  setVoiceSave("saved");
                  window.dispatchEvent(new Event("nautilo:profile-changed"));
                }}
              />
            ) : null}

            {voiceSave === "saving" ? (
              <p className="mt-2 text-xs text-foreground-muted">Saving…</p>
            ) : voiceSave === "saved" ? (
              <p className="mt-2 text-xs text-[var(--success)]">
                Voice saved.
              </p>
            ) : typeof voiceSave === "object" ? (
              <p className="mt-2 text-xs text-[var(--error)]">
                {voiceSave.error}
              </p>
            ) : null}
          </FieldRow>

        </>
      )}
    </SectionCard>
  );
}

function SoulFileViewer({
  soulFile,
  onEditInstructions,
}: {
  readonly soulFile: string | null;
  readonly onEditInstructions: () => void;
}) {
  const [open, setOpen] = useState(false);

  if (!soulFile) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm italic text-foreground-dim">
          No soul file yet. Use the wizard's instruction screen to describe how
          this Agent should feel, then generate one.
        </p>
        <Button variant="primary" onClick={onEditInstructions}>
          Add soul instructions…
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="max-h-28 overflow-y-auto rounded-md border border-border bg-background-element px-3 py-2">
        <pre className="whitespace-pre-wrap text-xs leading-relaxed text-foreground-muted">
          {soulFile}
        </pre>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="ghost" onClick={() => setOpen(true)}>
          View full soul
        </Button>
        <Button variant="ghost" onClick={onEditInstructions}>
          Edit soul instructions…
        </Button>
      </div>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="flex max-h-[80vh] w-full max-w-3xl flex-col rounded-lg border border-border-strong bg-background-panel shadow-xl">
            <header className="flex items-center justify-between border-b border-border px-5 py-3">
              <h2 className="text-lg font-semibold">Soul file</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded p-1 text-foreground-muted hover:text-foreground"
                aria-label="Close soul viewer"
              >
                ✕
              </button>
            </header>
            <div className="min-h-0 overflow-y-auto p-5">
              <pre className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                {soulFile}
              </pre>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
