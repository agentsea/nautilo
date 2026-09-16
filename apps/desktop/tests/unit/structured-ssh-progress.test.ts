import { describe, expect, test } from "bun:test";
import type { RelayStructuredSshProgressObservation } from "@nautilo/relay";

import {
  createStructuredSshExecProgressReporter,
  createStructuredSshTransferProgressReporter,
} from "../../electron/structured-ssh/progress.ts";

describe("structured SSH v15 progress", () => {
  test("redacts reconstructed local values across chunks with valid UTF-8 and truthful offsets", () => {
    const observations: RelayStructuredSshProgressObservation[] = [];
    const reporter = createStructuredSshExecProgressReporter((event) => observations.push(event), [
      "/Users/human",
      "/Users/human/.ssh/id_ed25519",
      "/private/tmp/agent.sock",
      "/app-data",
      "/workspace",
    ]);
    reporter.stdout(Buffer.from("before /Users/hu", "utf8"));
    reporter.stdout(Buffer.from("man/.ssh/id_ed25519 after ✓\n", "utf8"));
    reporter.stderr(Buffer.from("socket=/private/tmp/agent.sock\n", "utf8"));
    reporter.finish();

    const serialized = JSON.stringify(observations);
    expect(serialized).not.toContain("/Users/human");
    expect(serialized).not.toContain("/private/tmp/agent.sock");
    expect(observations).toHaveLength(2);
    expect(observations.map((event) => event.sequence)).toEqual([0, 1]);
    for (const event of observations) {
      if (event.kind !== "exec-output") throw new Error("expected exec output");
      expect(() => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(event.text, "utf8"))).not.toThrow();
      expect(event.endOffsetBytes).toBe(event.offsetBytes + Buffer.byteLength(event.text, "utf8") + (event.droppedBytes ?? 0));
      expect(event.droppedBytes).toBeGreaterThan(0);
    }
  });

  test("contains observer failures and reports only truthful SCP start/final observations", () => {
    const seen: RelayStructuredSshProgressObservation[] = [];
    const upload = createStructuredSshTransferProgressReporter("copy-upload", (event) => {
      seen.push(event);
      if (seen.length === 1) throw new Error("renderer gone");
    });
    upload.starting(12);
    upload.completed(12);
    upload.starting(12);
    expect(seen).toEqual([
      expect.objectContaining({ sequence: 0, operation: "copy-upload", kind: "transfer", phase: "starting", transferredBytes: 0, totalBytes: 12 }),
      expect.objectContaining({ sequence: 1, operation: "copy-upload", kind: "transfer", phase: "transferring", transferredBytes: 12, totalBytes: 12 }),
    ]);
    const unstarted: RelayStructuredSshProgressObservation[] = [];
    createStructuredSshTransferProgressReporter("copy-download", (event) => unstarted.push(event)).completed(12);
    expect(unstarted).toEqual([]);
  });

  test("splits large redacted output without losing raw-byte continuity", () => {
    const observations: RelayStructuredSshProgressObservation[] = [];
    const reporter = createStructuredSshExecProgressReporter((event) => observations.push(event), ["/app-data"]);
    reporter.stdout(Buffer.from(`/app-data${"x".repeat(5_000)}`, "utf8"));
    reporter.finish();
    const output = observations.filter((event) => event.kind === "exec-output");
    expect(output.length).toBeGreaterThan(1);
    for (let index = 0; index < output.length; index += 1) {
      const event = output[index]!;
      if (event.kind !== "exec-output") throw new Error("expected exec output");
      expect(event.endOffsetBytes).toBe(event.offsetBytes + Buffer.byteLength(event.text, "utf8") + (event.droppedBytes ?? 0));
      expect(Buffer.byteLength(event.text, "utf8")).toBeLessThanOrEqual(4 * 1024);
      if (index > 0) expect(event.offsetBytes).toBe((output[index - 1]! as Extract<RelayStructuredSshProgressObservation, { kind: "exec-output" }>).endOffsetBytes);
    }
  });
});
