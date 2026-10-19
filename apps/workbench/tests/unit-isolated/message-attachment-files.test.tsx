import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { reapplyHappyDomGlobals } from "../bun-dom-preload";

const fetchBytes = mock(async (_url: string, _options: RequestInit) => new Response("synthetic file"));
const save = mock(async (_blob: Blob, _name: string, _options: { signal: AbortSignal }) => {});
let user: string | null = "fixture-viewer";
mock.module("@nautilo/api-client/browser", () => ({ saveArtifactToDisk: save }));
mock.module("../../src/lib/api", () => ({ apiClient: {
  getCredentialGeneration: () => 1, getTokenProvider: () => async () => "fixture-bearer", getToken: () => null,
  getMessageAttachmentUrl: (id: string, opts: { roomId: string }) => `/api/message-attachments/${id}?roomId=${opts.roomId}`,
} }));
mock.module("../../src/lib/admission-fetch", () => ({ workbenchFetch: fetchBytes }));
mock.module("../../src/hooks/use-auth", () => ({ useAuth: () => ({ viewer: { sessionUserId: user, sessionActorId: user ? "fixture-actor" : null }, viewerGeneration: 1, credentialGeneration: 1 }) }));
const { MessageAttachmentFiles } = await import("../../src/components/message-attachment-files");
const file = { attachmentId: "fixture-file", filename: "brief.pdf", mimeType: "application/pdf", sizeBytes: 14 };
beforeEach(() => {
  reapplyHappyDomGlobals(); cleanup(); user = "fixture-viewer"; fetchBytes.mockClear(); save.mockClear();
  fetchBytes.mockImplementation(async () => new Response("synthetic file"));
});
afterEach(() => cleanup());

test("retained files remain visible and fetch bytes only for an explicit scoped download", async () => {
  const view = render(<MessageAttachmentFiles attachments={[file, { ...file, filename: "image.png", mimeType: "image/png" }]} roomId="fixture-room" />);
  expect(fetchBytes).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  expect(view.queryByRole("button", { name: "Download image.png" })).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Download brief.pdf" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(fetchBytes.mock.calls[0]?.[0]).toBe("/api/message-attachments/fixture-file?roomId=fixture-room");
  expect(fetchBytes.mock.calls[0]?.[1]).toMatchObject({ headers: { Authorization: "Bearer fixture-bearer" } });
  expect(save.mock.calls[0]?.[1]).toBe("brief.pdf");
});

test("a pending download cannot save files after switching Rooms", async () => {
  let release!: (value: Response) => void;
  fetchBytes.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const view = render(<MessageAttachmentFiles attachments={[file]} roomId="fixture-room" />);
  fireEvent.click(view.getByRole("button", { name: "Download brief.pdf" }));
  await waitFor(() => expect(fetchBytes).toHaveBeenCalledTimes(1));
  view.rerender(<MessageAttachmentFiles attachments={[file]} roomId="other-room" />);
  await act(async () => { release(new Response("old private file")); });
  expect(save).not.toHaveBeenCalled();
});

test("anonymous viewers receive no file controls or byte requests", () => {
  user = null;
  const view = render(<MessageAttachmentFiles attachments={[file]} roomId="fixture-room" />);
  expect(view.queryByRole("button")).toBeNull(); expect(fetchBytes).not.toHaveBeenCalled();
});
