import { expect, test } from "bun:test";
import { LiveAppCommandBroker } from "../../src/apps/live-app-command-broker";

const input = () => ({ documentVersion: { kind: "artifact_revision" as const, revision: 1 }, deadline: Date.now() + 10_000, command: { action: "pause" } });
test("only a presently listening exact session receives a command, once", async () => {
  const broker = new LiveAppCommandBroker();
  const life = new AbortController();
  expect((await broker.invoke("missing", input(), life.signal)).status).toBe("unavailable");
  const receiving = broker.listen("editor", life.signal);
  const result = broker.invoke("editor", input(), life.signal);
  const command = (await receiving)!;
  expect(command.command).toEqual({ action: "pause" });
  expect((await broker.invoke("editor", input(), life.signal)).status).toBe("busy");
  expect(broker.complete("other", command.requestId, {})).toBe(false);
  expect(broker.complete("editor", "wrong", {})).toBe(false);
  expect(broker.complete("editor", command.requestId, { state: "paused" })).toBe(true);
  expect(await result).toEqual({ status: "completed", result: { state: "paused" } });
  expect(broker.complete("editor", command.requestId, {})).toBe(false);
  expect((await broker.invoke("editor", input(), life.signal)).status).toBe("unavailable");
});
test("abort after dispatch is unknown, no delayed acknowledgement or replay", async () => {
  const broker = new LiveAppCommandBroker();
  const life = new AbortController();
  const receiving = broker.listen("editor", life.signal);
  const result = broker.invoke("editor", input(), life.signal);
  const command = (await receiving)!;
  life.abort();
  expect(await result).toEqual({ status: "unknown", stateChanged: "unknown", retrySafe: false });
  expect(broker.complete("editor", command.requestId, {})).toBe(false);
});
test("disconnect/revoke clears receiver and pending operation; duplicate listener does not steal it", async () => {
  const broker = new LiveAppCommandBroker();
  const life = new AbortController();
  const receiving = broker.listen("editor", life.signal);
  expect(await broker.listen("editor", life.signal)).toBeNull();
  broker.close("editor");
  expect(await receiving).toBeNull();
  const second = broker.listen("editor", life.signal);
  const result = broker.invoke("editor", input(), life.signal);
  await second;
  broker.close("editor");
  expect((await result).status).toBe("unknown");
});
test("expired commands never reach a receiver", async () => {
  const broker = new LiveAppCommandBroker();
  const life = new AbortController();
  const receiving = broker.listen("editor", life.signal);
  expect((await broker.invoke("editor", { ...input(), deadline: Date.now() - 1 }, life.signal)).status).toBe("unavailable");
  life.abort();
  expect(await receiving).toBeNull();
});
