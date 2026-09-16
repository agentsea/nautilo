/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { AgentPhotoLibraryApiError } from "@nautilo/api-client/browser";

import {
  uploadAndSelectAgentPhoto,
  type ProfileAgentPhotoApi,
} from "../../src/pages/settings/sections/profile-agent-photo-actions";

const scope = {
  serverInstanceId: "11111111-1111-4111-8111-111111111111",
  viewerUserId: "22222222-2222-4222-8222-222222222222",
  agentId: "33333333-3333-4333-8333-333333333333",
  selectionRevision: "3",
  libraryRevision: "8",
};
const entryId = "44444444-4444-4444-8444-444444444444";

function fixture(calls: string[]): ProfileAgentPhotoApi {
  return {
    getAgentPhotoLibraryCurrent: async () => ({
      current: { avatarRef: { kind: "preset", id: "avatar-01" }, entryId: null, lastUndoableRevisionId: null, scope },
      scope,
    }),
    uploadAgentPhotoLibraryEntry: async (_file, options) => {
      calls.push(`upload:${options.idempotencyKey}:${options.origin}:${options.fence.libraryRevision}`);
      return {
        operation: "create", entryIds: [entryId],
        entries: [{
          id: entryId, source: "upload", origin: "workbench",
          createdAt: "2026-08-04T10:00:00.000Z",
          media: {
            thumbnailUrl: `/api/profile/agent-photo-library/entries/${entryId}/media?size=thumb`,
            fullUrl: `/api/profile/agent-photo-library/entries/${entryId}/media?size=full`,
          },
        }],
        scope: { ...scope, libraryRevision: "9" },
      };
    },
    selectAgentPhotoLibraryEntry: async (input, options) => {
      calls.push(`select:${input.target.entryId}:${input.expectedSelectionRevision}:${options.idempotencyKey}:${options.origin}:${options.fence.libraryRevision}`);
      return {
        operation: "select", changed: true,
        currentAvatarRef: { kind: "uploaded", blobId: "photo-blob" }, currentEntryId: entryId,
        revisionId: "55555555-5555-4555-8555-555555555555",
        scope: { ...scope, selectionRevision: "4", libraryRevision: "9" },
      };
    },
  };
}

describe("Workbench Agent photo actions", () => {
  test("uploads then explicitly selects the owned entry with separate stable operations", async () => {
    const calls: string[] = [];
    let operation = 0;
    await uploadAndSelectAgentPhoto(
      fixture(calls),
      new Blob([new Uint8Array([1])], { type: "image/png" }),
      () => `${String(++operation).padStart(8, "0")}-0000-4000-8000-000000000000`,
      { requestGeneration: 2, getCurrentGeneration: () => 2 },
    );
    expect(calls).toEqual([
      "upload:00000001-0000-4000-8000-000000000000:workbench:8",
      `select:${entryId}:3:00000002-0000-4000-8000-000000000000:workbench:9`,
    ]);
  });

  test("preserves the shared structured authentication failure and never selects", async () => {
    const calls: string[] = [];
    const api = fixture(calls);
    api.uploadAgentPhotoLibraryEntry = async () => {
      throw new AgentPhotoLibraryApiError({
        status: 401, code: "authentication_required", message: "Sign in again",
        retryable: false,
      });
    };
    const failure = uploadAndSelectAgentPhoto(
      api,
      new Blob(["x"]),
      () => crypto.randomUUID(),
      { requestGeneration: 2, getCurrentGeneration: () => 2 },
    );
    await expect(failure).rejects.toMatchObject({ status: 401, code: "authentication_required" });
    expect(calls).toEqual([]);
  });
});
