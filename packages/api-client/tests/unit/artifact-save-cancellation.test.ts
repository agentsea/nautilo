import { expect, test } from "bun:test";
import { saveArtifactToDisk } from "../../src/client";

test("cancelled file reads never reach a browser download or native save", async () => {
  let release!: (bytes: ArrayBuffer) => void;
  const bytes = new Promise<ArrayBuffer>(resolve => { release = resolve; });
  const blob = new Blob(["synthetic"]);
  Object.defineProperty(blob, "arrayBuffer", { value: () => bytes });
  const controller = new AbortController();
  const saving = saveArtifactToDisk(blob, "brief.txt", { signal: controller.signal });
  controller.abort(); release(new ArrayBuffer(9));
  await saving;
  expect(controller.signal.aborted).toBe(true);
});

test("cancellation while a native save dialog is open never writes the selected path", async () => {
  const global = globalThis as unknown as { window?: unknown };
  const original = global.window;
  let open!: () => void, choose!: (result: { canceled: boolean; filePath: string }) => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  const picked = new Promise<{ canceled: boolean; filePath: string }>(resolve => { choose = resolve; });
  let writes = 0;
  global.window = { nautiloDesktop: { dialog: { showSaveDialog: () => { open(); return picked; } },
    fs: { writeFileBytes: async () => { writes++; } } } };
  try {
    const controller = new AbortController();
    const saving = saveArtifactToDisk(new Blob(["synthetic"]), "brief.txt", { signal: controller.signal });
    await opened; controller.abort(); choose({ canceled: false, filePath: "/path/to/download/brief.txt" });
    await saving; expect(writes).toBe(0);
  } finally { if (original === undefined) delete global.window; else global.window = original; }
});
