import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { reapplyHappyDomGlobals } from "../bun-dom-preload";

const getMessageAttachmentUrl = mock((attachmentId: string, input: { roomId: string }) =>
  `/api/message-attachments/${attachmentId}?roomId=${input.roomId}`,
);
const tokenProvider = mock(async () => "guest-bearer");
const workbenchFetch = mock(async () =>
  new Response(new Blob(["png"], { type: "image/png" }), { status: 200 }),
);
let viewerUserId = "guest-user";
let viewerActorId = "guest-actor";
let viewerGeneration = 4;

mock.module("../../src/lib/api", () => ({
  apiClient: {
    getMessageAttachmentUrl,
    getTokenProvider: () => tokenProvider,
    getToken: () => null,
  },
}));

mock.module("../../src/lib/admission-fetch", () => ({ workbenchFetch }));

mock.module("../../src/hooks/use-auth", () => ({
  useAuth: () => ({
    viewer: {
      role: "guest" as const,
      sessionUserId: viewerUserId,
      sessionActorId: viewerActorId,
      isVerified: false,
    },
    viewerGeneration,
  }),
}));

const { MessageAttachmentImages } = await import(
  "../../src/components/message-attachment-images"
);

const png = {
  attachmentId: "attachment-png",
  filename: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 3,
};

let revoked: string[];

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  getMessageAttachmentUrl.mockClear();
  tokenProvider.mockClear();
  workbenchFetch.mockClear();
  workbenchFetch.mockImplementation(async () =>
    new Response(new Blob(["png"], { type: "image/png" }), { status: 200 }),
  );
  revoked = [];
  viewerUserId = "guest-user";
  viewerActorId = "guest-actor";
  viewerGeneration = 4;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: mock(() => "blob:guest-png"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: mock((url: string) => revoked.push(url)),
  });
});

afterEach(() => cleanup());

describe("MessageAttachmentImages", () => {
  test("renders a Guest's PNG from the exact Room route with a bearer", async () => {
    const view = render(<MessageAttachmentImages attachments={[png]} roomId="room-active" />);

    const image = await view.findByRole("img", { name: "screenshot.png" });
    expect(image.getAttribute("src")).toBe("blob:guest-png");
    expect(getMessageAttachmentUrl).toHaveBeenCalledWith("attachment-png", {
      roomId: "room-active",
    });
    expect(workbenchFetch).toHaveBeenCalledTimes(1);
    const [, init] = workbenchFetch.mock.calls[0]!;
    expect(init?.headers).toEqual({ Authorization: "Bearer guest-bearer" });
    expect(view.getByRole("link", { name: "Open screenshot.png full size" }).getAttribute("href"))
      .toBe("blob:guest-png");
  });

  test("aborts the request and revokes its object URL on cleanup", async () => {
    let requestSignal: AbortSignal | undefined;
    workbenchFetch.mockImplementation(async (_url, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Response(new Blob(["png"], { type: "image/png" }), { status: 200 });
    });
    const view = render(<MessageAttachmentImages attachments={[png]} roomId="room-active" />);
    await view.findByRole("img", { name: "screenshot.png" });

    view.unmount();

    expect(requestSignal?.aborted).toBe(true);
    expect(revoked).toEqual(["blob:guest-png"]);
  });

  test("shows a bounded unavailable state after denial", async () => {
    workbenchFetch.mockImplementation(async () => new Response(null, { status: 404 }));
    const view = render(<MessageAttachmentImages attachments={[png]} roomId="room-active" />);

    await waitFor(() => {
      expect(view.getByRole("status").textContent).toContain("Image unavailable");
    });
    expect(view.queryByRole("img")).toBeNull();
  });

  test("removes the old image synchronously when Room or viewer identity changes", async () => {
    let objectUrlIndex = 0;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: mock(() => `blob:scoped-${++objectUrlIndex}`),
    });
    const view = render(<MessageAttachmentImages attachments={[png]} roomId="room-a" />);
    expect((await view.findByRole("img", { name: "screenshot.png" })).getAttribute("src"))
      .toBe("blob:scoped-1");

    view.rerender(<MessageAttachmentImages attachments={[png]} roomId="room-b" />);
    expect(view.queryByRole("img", { name: "screenshot.png" })).toBeNull();
    expect((await view.findByRole("img", { name: "screenshot.png" })).getAttribute("src"))
      .toBe("blob:scoped-2");

    viewerUserId = "other-user";
    viewerActorId = "other-actor";
    viewerGeneration += 1;
    view.rerender(<MessageAttachmentImages attachments={[png]} roomId="room-b" />);
    expect(view.queryByRole("img", { name: "screenshot.png" })).toBeNull();
    expect((await view.findByRole("img", { name: "screenshot.png" })).getAttribute("src"))
      .toBe("blob:scoped-3");
  });

  test("does not fetch without an exact Room or for unsupported media", async () => {
    const { rerender } = render(<MessageAttachmentImages attachments={[png]} roomId={null} />);
    rerender(<MessageAttachmentImages
      attachments={[{ ...png, attachmentId: "audio", mimeType: "audio/mpeg" }]}
      roomId="room-active"
    />);
    await Promise.resolve();

    expect(workbenchFetch).not.toHaveBeenCalled();
  });
});
