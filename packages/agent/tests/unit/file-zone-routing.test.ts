import { describe, expect, test } from "bun:test";
import {
  LocalFileBackend,
  selectFileBackend,
} from "../../src/tools/file/backend";

describe("selectFileBackend (M206)", () => {
  test("workspace/home/scratch stay local", () => {
    for (const zone of ["workspace", "home", "scratch"] as const) {
      const selected = selectFileBackend({
        zone,
        command: "read",
        ownerId: "u",
        registry: null,
      });
      expect(selected.ok).toBe(true);
      if (selected.ok) expect(selected.backend).toBeInstanceOf(LocalFileBackend);
    }
  });

  test("current and absolute never select RelayFileBackend", () => {
    for (const zone of ["current", "absolute"] as const) {
      const selected = selectFileBackend({
        zone,
        command: "read",
        ownerId: "u",
        registry: null,
      });
      expect(selected.ok).toBe(false);
      if (!selected.ok) {
        expect(selected.error).toContain("local-file relay dispatch");
      }
    }
  });
});
