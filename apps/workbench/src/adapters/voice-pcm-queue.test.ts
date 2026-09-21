import { describe, expect, test } from "bun:test";
import { VoicePcmQueue } from "./voice-pcm-queue";
const pcm = (values: number[]) => { const out = new Uint8Array(values.length * 2); const view = new DataView(out.buffer); values.forEach((v, i) => view.setInt16(i * 2, v, true)); return out; };
describe("continuous PCM audio clock", () => {
  test("adjacent packets add no silence or safety padding", () => {
    const queue = new VoicePcmQueue(24000, 24000, 2, 16);
    queue.write(pcm([1000, 2000]));
    const a = new Float32Array(1); queue.render(a);
    queue.write(pcm([3000, 4000]));
    const b = new Float32Array(3); queue.render(b);
    expect([...a, ...b]).toEqual([1000, 2000, 3000, 4000].map(v => v / 32768));
    expect(queue.underruns).toBe(0);
  });
  test("bounded queue refuses overflow and flushes a sub-pre-roll final reply", () => {
    const queue = new VoicePcmQueue(24000, 24000, 4, 4);
    expect(queue.write(pcm([1000, 2000]))).toBe(true);
    expect(queue.write(pcm([1, 2, 3]))).toBe(false);
    const output = new Float32Array(2); queue.render(output); expect([...output]).toEqual([0, 0]);
    queue.finish(); queue.render(output); expect([...output]).toEqual([1000, 2000].map(v => v / 32768));
    expect(queue.done).toBe(true);
  });
  test("resamples linearly without inserting gaps across source writes", () => {
    const queue = new VoicePcmQueue(24000, 48000, 2, 8);
    queue.write(pcm([0, 1000, 2000])); queue.finish();
    const output = new Float32Array(6); queue.render(output);
    expect([...output]).toEqual([0, 500, 1000, 1500, 2000, 2000].map(v => v / 32768));
    expect(queue.consumed).toBe(3);
  });
});
