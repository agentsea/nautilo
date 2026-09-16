import {describe, expect, test} from "bun:test";
import {encodeMessagePayloadV2} from "@nautilo/lattice-bridge";
import type {ProtectedReflectionMessageMetadata} from "@nautilo/lattice-bridge/server";
import {reflectionMessageSourceFingerprint} from "@nautilo/runtime";
import {createGateBoundReflectionMessageSources} from "../../src/reflection/protected-semantic-composition";

function fixture() {
  const metadata: ProtectedReflectionMessageMetadata = {messageId: 17, logicalSourceRef: "message:17", sessionId: "session", roomId: "room",
    namespaceId: "namespace", namespaceAccessRevision: 2, editRevision: 0, role: "user",
    inputBinding: {objectId: "object", namespaceId: "namespace", objectType: "nautilo-message-v2"}};
  const controller = new AbortController();
  let state: "available" | "waiting" | "missing" | "changed" = "available";
  const payload = encodeMessagePayloadV2({role: "user", content: "Friday review"});
  const source = createGateBoundReflectionMessageSources({messages: new Map([[metadata.logicalSourceRef, metadata]]),
    payloads: new Map([["object", {plaintext: payload}]]), roomAnchorRef: "room", signal: controller.signal,
    resolveMessage: async () => state === "available" ? {status: "available", metadata} : {status: state}});
  const dependency = source.messageValues.get("message:17")!.dependency;
  const read = () => source.sources.readExact({dependency, evidenceBindingRef: "binding", returnedBytesMaximum: 100});
  return {source, controller, payload, dependency, read, setState(value: typeof state) {state = value;}};
}

describe("protected native Message dependency support", () => {
  test("reads only declared bytes with the unchanged Stenographer fingerprint and zero edit revision", async () => {
    const f = fixture();
    expect(f.dependency.observedContentFingerprint).toBe(reflectionMessageSourceFingerprint({id: 17, editRevision: 0, content: "Friday review"}));
    expect(await f.read()).toEqual({status: "available", kind: "message", content: "Friday review"});
    f.source.dispose(); f.payload.fill(0);
  });
  test("a pending protected mapping is not treated as lost support", async () => {
    const f = fixture(); f.setState("waiting");
    expect(await f.read().then(() => null, (error: unknown) => error)).toBeInstanceOf(Error);
    f.setState("missing"); expect(await f.read()).toEqual({status: "unavailable"});
    f.setState("changed"); expect(await f.read()).toEqual({status: "changed"});
    f.source.dispose(); f.payload.fill(0);
  });
  test("cancellation clears decoded support and forbids later disclosure", async () => {
    const f = fixture(); f.controller.abort();
    expect(f.source.messageValues.size).toBe(0);
    expect(await f.read().then(() => null, (error: unknown) => error)).toBeInstanceOf(Error);
    f.payload.fill(0);
  });
});
