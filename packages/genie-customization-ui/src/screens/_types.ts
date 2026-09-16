/**
 * D091 Phase 2 — shared screen contract.
 *
 * Every screen component takes the same prop shape so the
 * orchestrator can render any of them with one switch. Screens
 * read state for display, dispatch actions for state changes,
 * and use `api` for IPC calls when they need server side-effects.
 */

import type { Dispatch } from "react";
import type { OnboardingAPI } from "../types";
import type { WizardState, WizardAction } from "../hooks/useWizardState";

export interface ScreenProps {
  state: WizardState;
  dispatch: Dispatch<WizardAction>;
  /** Resolved server URL — null until first IPC roundtrip
   *  succeeds. Screens that need it (Keys, Owner, Compiling,
   *  Avatar, Voice, Reveal) check + bail with a loading state. */
  serverUrl: string | null;
  /** Host-supplied API surface. Undefined only when the host cannot provide it. */
  api: OnboardingAPI | undefined;
  /** Optional one-screen override for targeted re-entry flows (Settings → Soul). */
  onPersonalityContinue?: () => void | Promise<void>;
  personalityContinueLabel?: string;
  personalityBusy?: boolean;
  personalityStartedAt?: number | null;
  personalityError?: string | null;
  soulPreview?: string;
  soulStreaming?: boolean;
  soulStreamError?: string | null;
  /** Optional one-screen override for targeted re-entry flows (Settings → Look). */
  onAvatarContinue?: () => void | Promise<void>;
  avatarContinueLabel?: string;
  avatarBusy?: boolean;
  avatarError?: string | null;
}
