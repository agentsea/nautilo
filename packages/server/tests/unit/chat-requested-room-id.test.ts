import { describe, test, expect } from "bun:test";
import {
  acceptsRequestedRoomIdFromUrl,
  extractChatRequestedRoomId,
  extractRequestedRoomIdFromUrl,
} from "../../src/lib/chat-requested-room-id";

describe("extractChatRequestedRoomId (M065 POST /api/chat body)", () => {
  test("returns UUID when body.roomId is a valid v4 string", () => {
    const id = "33333333-3333-4333-8333-333333333333";
    expect(extractChatRequestedRoomId({ message: "hi", roomId: id })).toBe(id);
  });

  test("returns undefined for non-UUID strings", () => {
    expect(extractChatRequestedRoomId({ roomId: "not-a-uuid" })).toBeUndefined();
    expect(extractChatRequestedRoomId({ roomId: "room:abc" })).toBeUndefined();
  });

  test("returns undefined for missing or invalid body shapes", () => {
    expect(extractChatRequestedRoomId(null)).toBeUndefined();
    expect(extractChatRequestedRoomId(undefined)).toBeUndefined();
    expect(extractChatRequestedRoomId([])).toBeUndefined();
    expect(extractChatRequestedRoomId("x")).toBeUndefined();
  });
});

describe("extractRequestedRoomIdFromUrl", () => {
  test("parses roomId from path+search", () => {
    const id = "44444444-4444-4444-8444-444444444444";
    expect(extractRequestedRoomIdFromUrl(`/api/workspace/artifacts?roomId=${id}`)).toBe(id);
  });

  test("returns undefined for invalid UUID", () => {
    expect(extractRequestedRoomIdFromUrl("/api/workspace/artifacts?roomId=bad")).toBeUndefined();
  });

  test("returns undefined for malformed URL", () => {
    expect(extractRequestedRoomIdFromUrl(":::")).toBeUndefined();
  });
});

describe("acceptsRequestedRoomIdFromUrl", () => {
  test("binds both Manage access stages to their explicit invoking Room", () => {
    expect(acceptsRequestedRoomIdFromUrl("GET", "/api/content-access", "/api/content-access?roomId=x")).toBe(true);
    for (const stage of ["prepare", "commit"]) {
      const path = `/api/content-access/${stage}`;
      expect(acceptsRequestedRoomIdFromUrl("POST", path, `${path}?roomId=x`)).toBe(true);
      expect(acceptsRequestedRoomIdFromUrl("GET", path, `${path}?roomId=x`)).toBe(false);
    }
    expect(acceptsRequestedRoomIdFromUrl("POST", "/api/content-access/other", "/api/content-access/other?roomId=x")).toBe(false);
  });

  test("admits the private connected-app media route to exact Room scoping", () => {
    expect(acceptsRequestedRoomIdFromUrl(
      "GET",
      "/api/connected-apps/result-media",
      "/api/connected-apps/result-media?ref=opaque-ref&roomId=44444444-4444-4444-8444-444444444444",
    )).toBe(true);
  });

  test("preserves the existing artifact, generated-media, attachment, office, and conversion routes", () => {
    expect(acceptsRequestedRoomIdFromUrl("GET", "/api/workspace/artifacts", "/api/workspace/artifacts?roomId=x")).toBe(true);
    expect(acceptsRequestedRoomIdFromUrl("GET", "/api/media-generations/:id", "/api/media-generations/id?roomId=x")).toBe(true);
    expect(acceptsRequestedRoomIdFromUrl("GET", "/api/video-generations/:id", "/api/video-generations/id?roomId=x")).toBe(true);
    expect(acceptsRequestedRoomIdFromUrl("GET", "/api/message-attachments/:id", "/api/message-attachments/id?roomId=x")).toBe(true);
    expect(acceptsRequestedRoomIdFromUrl("POST", "/api/office/new", "/api/office/new?roomId=x")).toBe(true);
    expect(acceptsRequestedRoomIdFromUrl("POST", "/api/apps/:appId/conversions/run", "/api/apps/demo/conversions/run?roomId=x")).toBe(true);
    expect(acceptsRequestedRoomIdFromUrl("GET", "/api/connected-apps", "/api/connected-apps?roomId=x")).toBe(false);
  });
});
