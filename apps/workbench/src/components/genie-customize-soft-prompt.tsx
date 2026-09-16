/**
 * D112 Phase 3 — one-time soft prompt when setup is `ready` but the
 * profile is not yet onboarded (`genieCustomized === false`).
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import type { SetupStatusResponse } from "@nautilo/api-client/browser";
import { useAuth } from "../hooks/use-auth";
import { useCan } from "../hooks/use-can";
import { desktopAPI, isDesktop } from "../lib/desktop";
import {
  genieSoftPromptPrimaryLabel,
  genieCustomizationPath,
  launchGenieCustomizationFromSoftPrompt,
  markGenieSoftPromptDismissed,
  readWorkbenchTheme,
  shouldOfferGenieSoftPrompt,
} from "../lib/genie-soft-prompt";
import {
  isServerGuideSessionActive,
  subscribeToServerGuideSession,
} from "../lib/server-guide-session";

interface GenieCustomizeSoftPromptProps {
  setupStatus: SetupStatusResponse;
  onDismissed?: () => void;
}

export function GenieCustomizeSoftPrompt({
  setupStatus,
  onDismissed,
}: GenieCustomizeSoftPromptProps) {
  const auth = useAuth();
  const can = useCan();
  const canInvokeAgents = can("invoke_agents");
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const guideSessionActive = useSyncExternalStore(
    subscribeToServerGuideSession,
    isServerGuideSessionActive,
    () => false,
  );
  /** Survives failed localStorage so the card does not immediately reopen. */
  const dismissedThisSessionRef = useRef(false);
  const prevSessionUserIdRef = useRef<string | null>(auth.viewer.sessionUserId);

  useEffect(() => {
    const sid = auth.viewer.sessionUserId;
    if (sid !== prevSessionUserIdRef.current) {
      dismissedThisSessionRef.current = false;
      prevSessionUserIdRef.current = sid;
    }

    if (!canInvokeAgents || setupStatus.viewer?.genieCustomized === true) {
      dismissedThisSessionRef.current = false;
      setOpen(false);
      return;
    }

    if (dismissedThisSessionRef.current) {
      setOpen(false);
      return;
    }

    if (guideSessionActive) {
      setOpen(false);
      return;
    }

    const ok = shouldOfferGenieSoftPrompt({
      setupState: setupStatus.setupState,
      genieCustomized: setupStatus.viewer?.genieCustomized,
      sessionUserId: sid,
      getItem: (k) => {
        try {
          return localStorage.getItem(k);
        } catch {
          return null;
        }
      },
    });
    setOpen(ok);
  }, [setupStatus, auth.viewer.sessionUserId, canInvokeAgents, guideSessionActive]);

  if (!open) return null;

  const hasDesktopBridge = isDesktop && desktopAPI !== null;
  const primaryLabel = genieSoftPromptPrimaryLabel(hasDesktopBridge);

  const dismiss = (after?: () => void) => {
    dismissedThisSessionRef.current = true;
    markGenieSoftPromptDismissed(auth.viewer.sessionUserId, (k, v) => {
      try {
        localStorage.setItem(k, v);
      } catch {
        /* ignore — dismissedThisSessionRef keeps the UI stable */
      }
    });
    setOpen(false);
    onDismissed?.();
    after?.();
  };

  return (
    <div
      role="dialog"
      aria-label="Genie customization"
      aria-modal="false"
      data-testid="genie-soft-prompt"
      className="pointer-events-auto fixed bottom-4 right-4 z-[60] w-full max-w-sm rounded-lg border border-border-strong bg-background-panel p-4 shadow-xl"
    >
      <p className="text-sm font-medium text-primary">Welcome to Nautilo</p>
      <p className="mt-2 text-sm text-foreground-muted">
        Want to personalize your Genie now? You can always do this later in
        Settings.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-[var(--on-primary)] hover:bg-primary-hover"
          onClick={() => {
            dismiss(() => {
              void launchGenieCustomizationFromSoftPrompt({
                hasDesktopBridge,
                onboardingOpen: desktopAPI?.onboarding.open,
                getAccessToken: () => auth.session.getAccessToken(),
                getTheme: () =>
                  readWorkbenchTheme((k) => {
                    try {
                      return localStorage.getItem(k);
                    } catch {
                      return null;
                    }
                  }),
                navigateToCustomization: () => {
                  void navigate(genieCustomizationPath());
                },
              });
            });
          }}
        >
          {primaryLabel}
        </button>
        <button
          type="button"
          className="rounded-md border border-border-strong px-3 py-1.5 text-sm text-primary hover:bg-background-muted"
          onClick={() => {
            dismiss();
          }}
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}
