/**
 * D487 — canonical manage_avatar tool-card renderer parser tests.
 */
import { describe, expect, test } from "bun:test";
import {
  buildPhotoSelectionRequest,
  formatCollapsedSummary,
  parseEnvelope,
  type ManageAvatarEnvelope,
} from "./manage-avatar";

describe("manage_avatar parseEnvelope", () => {
  test("parses valid generated preview envelope", () => {
    const env: ManageAvatarEnvelope = {
      action: "preview",
      source: "generate",
      selectionRevision: "7",
      prompt: "a blue fox",
      model: "gpt-image-2",
      provider: "openai",
      candidates: [
        { entryId: "entry-a", thumbnailUrl: "/thumb/a", fullUrl: "/full/a" },
        { entryId: "entry-b", thumbnailUrl: "/thumb/b", fullUrl: "/full/b" },
      ],
    };

    expect(parseEnvelope(JSON.stringify(env))).toEqual(env);
    expect(formatCollapsedSummary(JSON.stringify(env))).toBe(
      "Avatar · 2 candidates",
    );
  });

  test("parses valid preset preview envelope", () => {
    const env: ManageAvatarEnvelope = {
      action: "preview",
      source: "preset",
      selectionRevision: "0",
      candidates: [{ presetId: "avatar-12" }],
    };

    expect(parseEnvelope(JSON.stringify(env))).toEqual(env);
    expect(formatCollapsedSummary(JSON.stringify(env))).toBe(
      "Avatar · preset avatar-12",
    );
  });

  test("returns null for malformed envelopes", () => {
    expect(parseEnvelope(undefined)).toBeNull();
    expect(parseEnvelope("")).toBeNull();
    expect(parseEnvelope("not json")).toBeNull();
    expect(
      parseEnvelope(
        JSON.stringify({ action: "apply", source: "generate", candidates: [] }),
      ),
    ).toBeNull();
    expect(
      parseEnvelope(
        JSON.stringify({
          action: "preview",
          source: "generate",
          candidates: [],
        }),
      ),
    ).toBeNull();
    expect(
      parseEnvelope(
        JSON.stringify({
          action: "preview",
          source: "generate",
          selectionRevision: "1",
          candidates: [
            { blobId: "legacy-blob", thumbnailUrl: "/thumb", fullUrl: "/full" },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      parseEnvelope(
        JSON.stringify({
          action: "preview",
          source: "preset",
          selectionRevision: "1",
          candidates: [{ blobId: "generated-in-preset-envelope" }],
        }),
      ),
    ).toBeNull();
  });
});

describe("manage_avatar selection request", () => {
  test("preserves the preview revision and audits the card application as manage_avatar", () => {
    const request = buildPhotoSelectionRequest(
      { entryId: "entry-a", thumbnailUrl: "/thumb/a", fullUrl: "/full/a" },
      "7",
    );
    expect(request.input).toEqual({
      target: { kind: "entry", entryId: "entry-a" },
      expectedSelectionRevision: "7",
    });
    expect(request.options.origin).toBe("manage_avatar");
    expect(request.options.idempotencyKey).toBeTruthy();
  });
});
