import { afterEach, describe, expect, test } from "bun:test";
import {
  clearLocalArtifactSaveMutationsForTests,
  consumeLocalArtifactSaveMutation,
  finalizeLocalArtifactSaveMutationEvent,
  isLocalArtifactSaveMutation,
  registerLocalArtifactSaveMutation,
  settleLocalArtifactSaveMutation,
} from "../../src/editors/local-artifact-save-mutations";

afterEach(() => {
  clearLocalArtifactSaveMutationsForTests();
});

describe("local artifact save mutations", () => {
  test("recognizes a registered id without consuming it", () => {
    registerLocalArtifactSaveMutation("mut-1");
    expect(isLocalArtifactSaveMutation("mut-1")).toBe(true);
    expect(isLocalArtifactSaveMutation("mut-1")).toBe(true);
  });

  test("supports dual SSE echoes for one patch write", () => {
    registerLocalArtifactSaveMutation("mut-dual");
    expect(isLocalArtifactSaveMutation("mut-dual")).toBe(true);
    expect(consumeLocalArtifactSaveMutation("mut-dual")).toBe(true);
  });

  test("all subscribers classify response-before-event as own", () => {
    registerLocalArtifactSaveMutation("response-first");
    settleLocalArtifactSaveMutation("response-first", true);
    expect([
      consumeLocalArtifactSaveMutation("response-first"),
      consumeLocalArtifactSaveMutation("response-first"),
      consumeLocalArtifactSaveMutation("response-first"),
    ]).toEqual([true, true, true]);
    finalizeLocalArtifactSaveMutationEvent("response-first");
    expect(isLocalArtifactSaveMutation("response-first")).toBe(false);
  });

  test("event-before-response finalization cannot be resurrected", () => {
    registerLocalArtifactSaveMutation("event-first");
    expect([
      consumeLocalArtifactSaveMutation("event-first"),
      consumeLocalArtifactSaveMutation("event-first"),
      consumeLocalArtifactSaveMutation("event-first"),
    ]).toEqual([true, true, true]);
    finalizeLocalArtifactSaveMutationEvent("event-first");
    settleLocalArtifactSaveMutation("event-first", true);
    expect(isLocalArtifactSaveMutation("event-first")).toBe(false);
  });

  test("returns false for unknown or missing ids", () => {
    expect(isLocalArtifactSaveMutation(undefined)).toBe(false);
    expect(isLocalArtifactSaveMutation("missing")).toBe(false);
  });
});
