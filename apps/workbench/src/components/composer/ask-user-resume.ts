/**
 * D279 Phase 4 — resume contract for `ask_user`: re-dispatch the original
 * human message with `uiSelectedBotActorId` via the canonical room send path.
 * Distinct from `approval.ask` interrupt/resume (no suspended turn).
 */

import { apiClient } from "../../lib/api";
import { withCurrentClientActionSession } from "../../lib/client-action-session";
import { sendOrdinaryRoomMessage } from "../../lib/ordinary-room-message";
import { readFileContext } from "../../adapters/file-context-ref";
import {
  readActiveMiniApp,
  readLiveMiniAppSession,
} from "../../adapters/mini-app-context-ref";
import {
  clearAskUserResumeContext,
  readAskUserResumeContext,
} from "./ask-user-resume-context";
import { clearAskUserPicker } from "./ask-user-state";

export interface ResumeAskUserPickParams {
  readonly roomId: string;
  readonly botActorId: string;
  readonly content: string;
  /**
   * D302 R13 — original human row's turn id (from the `conductor.ask_user`
   * event). Echoed as `resumeTurnId` so the woken bot's turn reuses the same
   * fingerprint and the server collapses the re-sent human row (no double-post).
   */
  readonly humanTurnId?: string | null;
  /** Original persisted human message id (exclude it from the bot context block on resume). */
  readonly messageId?: string | null;
  /** Current renderer posture used only when the original envelope is unavailable. */
  readonly voiceMode?: boolean;
  /** Current renderer posture used only when the original envelope is unavailable. */
  readonly autoApprove?: boolean;
}

export async function resumeAskUserPick(params: ResumeAskUserPickParams): Promise<{
  readonly uiSelectedBotActorId: string;
  readonly content: string;
}> {
  const content = params.content.trim();
  if (!content) {
    throw new Error("Cannot resume ask_user with empty content");
  }

  const retainedContext = readAskUserResumeContext(
    params.roomId,
    params.messageId ?? null,
  );
  const fileContext = readFileContext();
  const activeMiniApp = readActiveMiniApp();
  const liveMiniAppSession = readLiveMiniAppSession();
  const fallbackContext = {
    voiceMode: params.voiceMode === true,
    autoApprove: params.autoApprove === true,
    ...fileContext,
    ...(activeMiniApp ? { activeMiniApp } : {}),
    ...(liveMiniAppSession ? { liveMiniAppSession } : {}),
  };

  await sendOrdinaryRoomMessage(apiClient, params.roomId, withCurrentClientActionSession({
    ...(retainedContext ?? fallbackContext),
    content,
    uiSelectedBotActorId: params.botActorId,
    ...(params.humanTurnId ? { resumeTurnId: params.humanTurnId } : {}),
    ...(params.messageId && Number.isInteger(Number(params.messageId))
      ? { resumeMessageId: Number(params.messageId) }
      : {}),
  }));

  clearAskUserResumeContext(params.roomId, params.messageId);
  clearAskUserPicker();

  return {
    uiSelectedBotActorId: params.botActorId,
    content,
  };
}
