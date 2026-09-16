import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  requestWebsiteConnection,
  setWebsiteConnectionIntentDispatcher,
} from "./website-connection-intent";

afterEach(() => setWebsiteConnectionIntentDispatcher(null));

describe("website connection intent", () => {
  test("is transient until the protected connection journey installs a consumer", () => {
    expect(requestWebsiteConnection({ kind: "catalogue", websiteId: "notion" })).toBeFalse();

    const consume = mock(() => {});
    setWebsiteConnectionIntentDispatcher(consume);
    expect(requestWebsiteConnection({ kind: "custom", url: "https://example.com" })).toBeTrue();
    expect(consume).toHaveBeenCalledWith({ kind: "custom", url: "https://example.com" });
  });
});
