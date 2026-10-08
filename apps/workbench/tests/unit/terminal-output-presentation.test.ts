import { describe, expect, test } from "bun:test";
import { stripAnsiSgr } from "../../src/lib/terminal-output-presentation";

describe("stripAnsiSgr", () => {
  test("removes formatting inside a Vite loopback URL", () => {
    expect(stripAnsiSgr("Local: http://127.0.0.1:\u001b[1m4321\u001b[22m/\u001b[39m"))
      .toBe("Local: http://127.0.0.1:4321/");
  });

  test("leaves multiline plain Unicode output unchanged", () => {
    const plain = "VITE v7.0.0\n  ➜  Local: http://localhost:5173/\nReady ✓";
    expect(stripAnsiSgr(plain)).toBe(plain);
  });

  test("does not modify the source receipt string", () => {
    const receipt = "http://127.0.0.1:\u001b[1m4321\u001b[22m/";
    const presentation = stripAnsiSgr(receipt);

    expect(presentation).toBe("http://127.0.0.1:4321/");
    expect(receipt).toBe("http://127.0.0.1:\u001b[1m4321\u001b[22m/");
  });
});
