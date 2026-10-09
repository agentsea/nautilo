import { expect, test } from "bun:test";
import { hasOwnedLoopbackListener } from "../../electron/local-execution-preview-probe";

test("exact group, family and port listener proof", () => {
  expect(hasOwnedLoopbackListener("p55\ng42\nf4\nn127.0.0.1:4100\n", 42, 4100, false)).toBe(true);
  expect(hasOwnedLoopbackListener("p55\ng42\nf4\nn*:4100\n", 42, 4100, false)).toBe(true);
  expect(hasOwnedLoopbackListener("p55\ng42\nf4\nn[::1]:4100\n", 42, 4100, true)).toBe(true);
  for (const output of ["", "p55\ng43\nf4\nn*:4100\n", "p55\ng42\nf4\nn*:4101\n",
    "p55\ng42\nf4\nn[::1]:4100\n", "p55\ng42\nf4\nn10.0.0.2:4100\n",
    "p55\ng42\nf4\nn*:4101\np56\nf4\nn*:4100\n"]) {
    expect(hasOwnedLoopbackListener(output, 42, 4100, false)).toBe(false);
  }
});
