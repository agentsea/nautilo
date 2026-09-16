import { describe, expect, test } from "bun:test";
import { resolveAvatarSrc } from "../src/screens/AvatarScreen";

describe("avatar source resolution", () => {
  test("preserves browser object URLs returned by web avatar generation", () => {
    const objectUrl = "blob:http://127.0.0.1:4801/generated-avatar";

    expect(resolveAvatarSrc(objectUrl, "http://127.0.0.1:4801")).toBe(objectUrl);
  });

  test("preserves absolute and data URLs", () => {
    expect(resolveAvatarSrc("https://example.com/avatar.png", null)).toBe(
      "https://example.com/avatar.png",
    );
    expect(resolveAvatarSrc("data:image/png;base64,abc", null)).toBe(
      "data:image/png;base64,abc",
    );
  });

  test("anchors server-relative preset URLs to the Nautilo server", () => {
    expect(
      resolveAvatarSrc(
        "/api/onboarding/images/avatars/avatar-01.webp",
        "http://127.0.0.1:4801",
      ),
    ).toBe(
      "http://127.0.0.1:4801/api/onboarding/images/avatars/avatar-01.webp",
    );
  });
});
