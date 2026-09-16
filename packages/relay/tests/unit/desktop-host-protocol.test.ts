import { describe, expect, test } from "bun:test";

import {
  RELAY_HOST_COMPONENT,
  RELAY_HOST_CONTROL_MAX_BYTES,
  RELAY_HOST_PROTOCOL_VERSION,
  RelayHostFrameDecoder,
  RelayHostProtocolError,
  encodeRelayHostFrame,
  parseRelayHostControlMessage,
} from "../../src/desktop-host-protocol.ts";

const ready = {
  protocolVersion: RELAY_HOST_PROTOCOL_VERSION,
  kind: "ready" as const,
  component: RELAY_HOST_COMPONENT,
  hostVersion: "1.0.0",
  nonce: "nonce-1",
};

describe("private Relay Host framing", () => {
  test("decodes a fragmented length-prefixed frame exactly once", () => {
    const frame = encodeRelayHostFrame(ready);
    const decoder = new RelayHostFrameDecoder();
    expect(decoder.push(frame.subarray(0, 2))).toEqual([]);
    expect(decoder.push(frame.subarray(2, 9))).toEqual([]);
    expect(decoder.push(frame.subarray(9))).toEqual([ready]);
    expect(() => decoder.finish()).not.toThrow();
  });

  test("decodes coalesced frames without merging their settlements", () => {
    const first = encodeRelayHostFrame(ready);
    const secondMessage = { ...ready, nonce: "nonce-2" };
    const second = encodeRelayHostFrame(secondMessage);
    const decoder = new RelayHostFrameDecoder();
    expect(decoder.push(Buffer.concat([first, second]))).toEqual([ready, secondMessage]);
    expect(() => decoder.finish()).not.toThrow();
  });

  test("rejects unknown fields, kinds, and protocol versions", () => {
    expect(() => parseRelayHostControlMessage({ ...ready, arbitrary: true })).toThrow(RelayHostProtocolError);
    expect(() => parseRelayHostControlMessage({ ...ready, kind: "execute-anything" })).toThrow(RelayHostProtocolError);
    expect(() => parseRelayHostControlMessage({ ...ready, protocolVersion: 2 })).toThrow(RelayHostProtocolError);
  });

  test("rejects an oversized prefix before allocating its body", () => {
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, RELAY_HOST_CONTROL_MAX_BYTES + 1, false);
    const decoder = new RelayHostFrameDecoder();
    expect(() => decoder.push(prefix)).toThrow(new RelayHostProtocolError("frame-too-large"));
  });

  test("rejects duplicate decoded keys before JSON parsing can collapse them", () => {
    const raw = Buffer.from('{"protocolVersion":1,"kind":"ready","component":"nautilo-relay-host","hostVersion":"1.0.0","nonce":"first","n\\u006fnce":"second"}');
    const frame = new Uint8Array(raw.byteLength + 4);
    new DataView(frame.buffer).setUint32(0, raw.byteLength, false);
    frame.set(raw, 4);
    expect(() => new RelayHostFrameDecoder().push(frame)).toThrow(new RelayHostProtocolError("invalid-message"));
  });

  test("rejects invalid UTF-8 and abrupt EOF", () => {
    const invalidUtf8 = new Uint8Array([0, 0, 0, 2, 0xc3, 0x28]);
    expect(() => new RelayHostFrameDecoder().push(invalidUtf8)).toThrow(
      new RelayHostProtocolError("invalid-message"),
    );

    const decoder = new RelayHostFrameDecoder();
    decoder.push(encodeRelayHostFrame(ready).subarray(0, 12));
    expect(() => decoder.finish()).toThrow(new RelayHostProtocolError("invalid-frame"));
  });

  test("derives the control ceiling from existing large Relay payloads", () => {
    expect(RELAY_HOST_CONTROL_MAX_BYTES).toBe(64 * 1024 * 1024);
  });
});
