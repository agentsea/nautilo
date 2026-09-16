import { describe, expect, test } from "bun:test";

import { createBrowserArtifactFileHandoff } from "./artifact-file-handoff.web";

describe("browser artifact file handoff", () => {
  test("opens only retained browser object URLs with no opener authority", () => {
    const calls: string[] = [];
    const anchor = {
      href: "",
      target: "",
      rel: "",
      click: () => calls.push("click"),
      remove: () => calls.push("remove"),
    };
    const handoff = createBrowserArtifactFileHandoff({
      createAnchor: () => anchor,
      append: () => calls.push("append"),
    });
    expect(handoff.isAvailable("blob:https://alpha.example.test/pdf")).toBe(true);
    expect(handoff.isAvailable("https://alpha.example.test/api/pdf?token=secret")).toBe(false);
    handoff.open("blob:https://alpha.example.test/pdf", {
      title: "Open PDF",
      mimeType: "application/pdf",
    });
    expect(anchor).toMatchObject({
      href: "blob:https://alpha.example.test/pdf",
      target: "_blank",
      rel: "noopener noreferrer",
    });
    expect(calls).toEqual(["append", "click", "remove"]);
  });

  test("fails closed without a browser document or object URL", () => {
    const handoff = createBrowserArtifactFileHandoff(null);
    expect(handoff.isAvailable("blob:https://alpha.example.test/pdf")).toBe(false);
    expect(() => handoff.open("file:///native-cache/pdf", {
      title: "Open PDF",
      mimeType: "application/pdf",
    })).toThrow("unavailable");
  });
});
