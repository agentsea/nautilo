import type {
  AgentAvatarUploadInput,
  AgentPhotoLibraryFence,
} from "@nautilo/api-client/browser";
import type {
  AgentPhotoLibraryCreateResponse,
  AgentPhotoLibraryCurrentResponse,
  AgentPhotoLibrarySelectionResponse,
} from "@nautilo/types";

export interface ProfileAgentPhotoApi {
  getAgentPhotoLibraryCurrent(): Promise<AgentPhotoLibraryCurrentResponse>;
  uploadAgentPhotoLibraryEntry(
    file: AgentAvatarUploadInput,
    options: { idempotencyKey: string; origin: "workbench"; fence: AgentPhotoLibraryFence },
  ): Promise<AgentPhotoLibraryCreateResponse>;
  selectAgentPhotoLibraryEntry(
    input: { target: { kind: "entry"; entryId: string }; expectedSelectionRevision: string },
    options: { idempotencyKey: string; origin: "workbench"; fence: AgentPhotoLibraryFence },
  ): Promise<AgentPhotoLibrarySelectionResponse>;
}

/** Uploading from the existing profile surface means "use this photo now". */
export async function uploadAndSelectAgentPhoto(
  api: ProfileAgentPhotoApi,
  file: AgentAvatarUploadInput,
  randomUuid: () => string,
  generation: { requestGeneration: number; getCurrentGeneration: () => number },
): Promise<void> {
  const before = await api.getAgentPhotoLibraryCurrent();
  const created = await api.uploadAgentPhotoLibraryEntry(file, {
    idempotencyKey: randomUuid(),
    origin: "workbench",
    fence: photoFence(before, generation),
  });
  const entryId = created.entryIds[0];
  if (!entryId) throw new Error("Nautilo did not return the uploaded photo.");
  await api.selectAgentPhotoLibraryEntry({
    target: { kind: "entry", entryId },
    expectedSelectionRevision: created.scope.selectionRevision,
  }, {
    idempotencyKey: randomUuid(),
    origin: "workbench",
    fence: photoFence({
      current: { ...before.current, scope: created.scope },
      scope: created.scope,
    }, generation),
  });
}

function photoFence(
  response: AgentPhotoLibraryCurrentResponse,
  generation: { requestGeneration: number; getCurrentGeneration: () => number },
): AgentPhotoLibraryFence {
  return {
    serverInstanceId: response.scope.serverInstanceId,
    viewerUserId: response.scope.viewerUserId,
    agentId: response.scope.agentId,
    selectionRevision: response.scope.selectionRevision,
    libraryRevision: response.scope.libraryRevision,
    requestGeneration: generation.requestGeneration,
    getCurrentGeneration: generation.getCurrentGeneration,
  };
}
