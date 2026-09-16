import { describe, test, expect } from "bun:test";
import { eventBus } from "../../src/event-bus";
import type { ServerEvent } from "@nautilo/types";

describe("EventBus", () => {
  test("emits events to listeners", () => {
    const received: ServerEvent[] = [];
    const handler = (e: ServerEvent) => received.push(e);

    eventBus.on(handler);
    eventBus.emit({ type: "job.status", jobId: "j1", status: "running" });
    eventBus.off(handler);

    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("job.status");
  });

  test("supports multiple listeners", () => {
    let count = 0;
    const h1 = () => { count++; };
    const h2 = () => { count++; };

    eventBus.on(h1);
    eventBus.on(h2);
    eventBus.emit({ type: "job.status", jobId: "j2", status: "completed" });
    eventBus.off(h1);
    eventBus.off(h2);

    expect(count).toBe(2);
  });

  test("off removes listener", () => {
    let count = 0;
    const handler = () => { count++; };

    eventBus.on(handler);
    eventBus.emit({ type: "job.status", jobId: "j3", status: "queued" });
    eventBus.off(handler);
    eventBus.emit({ type: "job.status", jobId: "j4", status: "queued" });

    expect(count).toBe(1);
  });
});
