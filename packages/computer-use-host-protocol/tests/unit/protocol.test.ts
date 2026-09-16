import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { describe, expect, test } from "bun:test";
import {
  COMPUTER_USE_HOST_CONTROL_MAX_BYTES,
  ComputerUseHostProtocolError,
  ComputerUseHostResultGate,
  canonicalizeComputerUseJson,
  parseComputerUseHostControlMessage,
  parseComputerUseHostRejectedResult,
  projectComputerUseHostRejectionSettlement,
  stringifyCanonicalComputerUseJson,
  type ComputerUseHostAuthorityScope,
  type ComputerUseHostContract,
  type ComputerUseJson,
} from "../../src/index.ts";
import {
  AttachmentFrameDecoder,
  ControlFrameDecoder,
  decodeControlFrame,
  encodeControlFrame,
  encodePngAttachmentFrame,
  parsePngAttachment,
} from "../../src/node.ts";

const authority: ComputerUseHostAuthorityScope = {
  authorityLeaseId: "lease-1",
  authorityGeneration: 1,
};
const fence = { hostGeneration: "host-1", driverGeneration: "driver-1", cancellationGeneration: 1 } as const;
const contract: ComputerUseHostContract = {
  contractNamespace: "nautilo.computer_use",
  contractId: "browser.read_page",
  contractVersion: 1,
  schemaDigest: "sha256:2cfdca7707a07eea9256ce9316c64feb0623563ad734e96c64a1b58c9fcb5fe4",
  effectClass: "read",
  replayClass: "safe",
  authorityClass: "standing_computer_use",
  attachmentClass: "none",
  disclosureClass: "semantic",
};
const request = (argumentsValue: Record<string, ComputerUseJson> = { target: { reference: "opaque" } }) => ({ kind: "request", protocol: { major: 3, minor: 0 }, requestId: "request-1", authority, fence, contract, arguments: argumentsValue } as const);
const result = () => ({ kind: "result", protocol: { major: 3, minor: 0 }, requestId: "request-1", fence, contract, settlement: "completed", result: { title: "Example", complete: true } } as const);
const expectation = (expectedContract: ComputerUseHostContract = contract) => ({
  requestId: "request-1",
  ...fence,
  authority,
  contract: expectedContract,
});
const cancellation = () => ({
  kind: "cancel",
  protocol: { major: 3, minor: 0 },
  requestId: "request-1",
  authority,
  fence,
} as const);

function protocolError(action: () => unknown, code: ComputerUseHostProtocolError["code"]): void {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(ComputerUseHostProtocolError);
    expect((error as ComputerUseHostProtocolError).code).toBe(code);
    return;
  }
  throw new Error("expected protocol error");
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const hashed = Buffer.concat([typeBytes, data]);
  let crc = 0xffffffff;
  for (const byte of hashed) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 0 ? crc >>> 1 : (crc >>> 1) ^ 0xedb88320;
  }
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length);
  typeBytes.copy(output, 4);
  Buffer.from(data).copy(output, 8);
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
  return output;
}

function onePixelPng(): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Uint8Array.from(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 255]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]));
}

describe("generic browser-safe broker protocol", () => {
  test("owns deterministic semantics-free canonical JSON", () => {
    const lineSeparator = String.fromCodePoint(0x2028);
    const left = {
      z: 0,
      a: { beta: [true, { y: "last", x: "first" }], alpha: -0 },
      text: lineSeparator,
    };
    const right = {
      text: lineSeparator,
      a: { alpha: 0, beta: [true, { x: "first", y: "last" }] },
      z: 0,
    };
    const expected = `{"a":{"alpha":0,"beta":[true,{"x":"first","y":"last"}]},"text":${JSON.stringify(lineSeparator)},"z":0}`;
    expect(stringifyCanonicalComputerUseJson(left)).toBe(expected);
    expect(stringifyCanonicalComputerUseJson(right)).toBe(expected);
    expect(stringifyCanonicalComputerUseJson({ "2": "two", "10": "ten" }))
      .toBe('{"10":"ten","2":"two"}');
    expect(canonicalizeComputerUseJson(left)).toEqual(canonicalizeComputerUseJson(right));

    const leftFrame = encodeControlFrame(request({ z: 0, a: left }));
    const rightFrame = encodeControlFrame(request({ a: right, z: 0 }));
    expect(leftFrame).toEqual(rightFrame);

    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    protocolError(() => canonicalizeComputerUseJson(cyclic), "invalid_message");
    protocolError(() => canonicalizeComputerUseJson({ value: Number.NaN }), "invalid_message");
    protocolError(() => canonicalizeComputerUseJson({ value: undefined }), "invalid_message");
    const sparse = new Array<unknown>(1);
    protocolError(() => canonicalizeComputerUseJson(sparse), "invalid_message");
    const decorated = [1] as unknown[] & { extra?: number };
    decorated.extra = 2;
    protocolError(() => canonicalizeComputerUseJson(decorated), "invalid_message");
  });

  test("does not compile public Computer Use semantics into the protocol boundary", async () => {
    const browserFiles = await Promise.all([
      "../../src/protocol.ts",
      "../../src/index.ts",
      "../../src/host-wire.ts",
    ].map(async (path) => await Bun.file(new URL(path, import.meta.url)).text()));
    const nodeWire = await Bun.file(new URL("../../src/node-wire.ts", import.meta.url)).text();
    const browserSource = browserFiles.join("\n");
    const allSource = `${browserSource}\n${nodeWire}`;
    expect(browserSource).not.toMatch(/node:/);
    expect(allSource).not.toMatch(/@nautilo\/(?:agent|relay|types)|cua-adapter|semantic-contract/);
    for (const semanticToken of [
      "computer_observe",
      "computer_do",
      "computer_verify",
      "type_text",
      "set_value",
      "drag_drop",
      "launch_app",
      "create_window",
      "AXTextArea",
      "dctx_",
      "dtgt_",
    ]) expect(allSource).not.toContain(semanticToken);
  });

  test("accepts arbitrary contract IDs without compiling a tool or Cua-operation enum", () => {
    expect(parseComputerUseHostControlMessage(request())).toEqual(request());
    expect(parseComputerUseHostControlMessage({
      kind: "ready",
      protocol: { major: 3, minor: 0 },
      hostGeneration: "host-1",
      driverGeneration: "driver-1",
      contracts: [contract, { ...contract, contractId: "native.set_value", effectClass: "mutate", replayClass: "at_most_once" }],
    })).toEqual({
      kind: "ready",
      protocol: { major: 3, minor: 0 },
      hostGeneration: "host-1",
      driverGeneration: "driver-1",
      contracts: [contract, { ...contract, contractId: "native.set_value", effectClass: "mutate", replayClass: "at_most_once" }],
    });
    expect(parseComputerUseHostControlMessage({ ...request(), contract: { ...contract, contractId: "native.open_menu" } })).toMatchObject({ contract: { contractId: "native.open_menu" } });
    protocolError(() => parseComputerUseHostControlMessage({ ...request(), contract: { ...contract, contractId: "Computer Observe" } }), "invalid_message");
    protocolError(() => parseComputerUseHostControlMessage({ ...request(), contract: { ...contract, contractVersion: 0 } }), "invalid_message");
    protocolError(() => parseComputerUseHostControlMessage({ ...request(), protocol: { major: 2, minor: 0 } }), "invalid_message");
  });

  test("owns one strict contract-independent Host rejection grammar", () => {
    for (const [reason, settlement] of [
      ["stale_generation", "stale"],
      ["duplicate_request", "fenced"],
      ["unsupported_contract", "fenced"],
      ["cancelled", "cancelled"],
      ["host_failure", "failed"],
    ] as const) {
      expect(parseComputerUseHostRejectedResult({ status: "host_rejected", reason })).toEqual({ status: "host_rejected", reason });
      expect(projectComputerUseHostRejectionSettlement(reason, contract)).toBe(settlement);
    }
    expect(projectComputerUseHostRejectionSettlement("host_failure", { effectClass: "mutate", replayClass: "at_most_once" })).toBe("unknown_completion");
    expect(projectComputerUseHostRejectionSettlement("host_failure", { effectClass: "sensitive", replayClass: "at_most_once" })).toBe("unknown_completion");
    protocolError(() => parseComputerUseHostRejectedResult({ status: "host_rejected", reason: "provider_said_no" }), "invalid_message");
    protocolError(() => parseComputerUseHostRejectedResult({ status: "host_rejected", reason: "host_failure", providerText: "must not cross" }), "invalid_message");
  });

  test("rejects every full-descriptor, request, and generation mismatch before settlement", () => {
    protocolError(() => parseComputerUseHostControlMessage({ ...request(), authority: { ...authority, originHumanId: "must-not-cross" } }), "invalid_message");
    const gate = new ComputerUseHostResultGate(expectation());
    expect(gate.accept(result())).toEqual(result());
    protocolError(() => gate.accept(result()), "invalid_message");

    const descriptorMismatches: ComputerUseHostContract[] = [
      { ...contract, contractNamespace: "other.computer_use" },
      { ...contract, contractId: "browser.other" },
      { ...contract, contractVersion: 2 },
      { ...contract, schemaDigest: `sha256:${"0".repeat(64)}` },
      { ...contract, effectClass: "mutate" },
      { ...contract, replayClass: "at_most_once" },
      { ...contract, authorityClass: "different" as "standing_computer_use" },
      { ...contract, attachmentClass: "png" },
      { ...contract, disclosureClass: "visual" },
    ];
    for (const mismatched of descriptorMismatches) {
      protocolError(() => new ComputerUseHostResultGate(expectation()).accept({
        ...result(),
        contract: mismatched,
      }), "invalid_message");
    }
    for (const mismatched of [
      { ...result(), requestId: "request-2" },
      { ...result(), fence: { ...fence, hostGeneration: "host-2" } },
      { ...result(), fence: { ...fence, driverGeneration: "driver-2" } },
      { ...result(), fence: { ...fence, cancellationGeneration: 0 } },
      { ...result(), fence: { ...fence, cancellationGeneration: 2 } },
    ]) protocolError(() => new ComputerUseHostResultGate(expectation()).accept(mismatched), "invalid_message");
  });

  test("settles cancellation once for the exact authority and cancellation generation", () => {
    const cancelled = new ComputerUseHostResultGate(expectation());
    cancelled.cancel(cancellation());
    protocolError(() => cancelled.accept(result()), "invalid_message");
    protocolError(() => cancelled.cancel(cancellation()), "invalid_message");

    for (const mismatched of [
      { ...cancellation(), requestId: "request-2" },
      { ...cancellation(), authority: { ...authority, authorityLeaseId: "lease-2" } },
      { ...cancellation(), authority: { ...authority, authorityGeneration: 2 } },
      { ...cancellation(), fence: { ...fence, hostGeneration: "host-2" } },
      { ...cancellation(), fence: { ...fence, driverGeneration: "driver-2" } },
      { ...cancellation(), fence: { ...fence, cancellationGeneration: 0 } },
      { ...cancellation(), fence: { ...fence, cancellationGeneration: 2 } },
    ]) protocolError(() => new ComputerUseHostResultGate(expectation()).cancel(mismatched), "invalid_message");

    const completed = new ComputerUseHostResultGate(expectation());
    completed.accept(result());
    protocolError(() => completed.cancel(cancellation()), "invalid_message");
  });

  test("strictly frames fragmented JSON, duplicate keys, truncation, overrun, and the reviewed boundary", () => {
    const frame = encodeControlFrame(request());
    expect(new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, false)).toBe(frame.length - 4);
    for (let split = 1; split < frame.length; split += 1) {
      const decoder = new ControlFrameDecoder();
      expect(decoder.push(frame.subarray(0, split))).toEqual([]);
      expect(decoder.push(frame.subarray(split))).toEqual([request()]);
      decoder.finish();
    }
    protocolError(() => decodeControlFrame(frame.subarray(0, -1)), "invalid_frame");
    const overrun = new Uint8Array(frame.length + 1); overrun.set(frame);
    protocolError(() => decodeControlFrame(overrun), "invalid_frame");
    const duplicateBody = new TextEncoder().encode('{"kind":"request","k\\u0069nd":"cancel"}');
    const duplicateFrame = new Uint8Array(duplicateBody.length + 4);
    new DataView(duplicateFrame.buffer).setUint32(0, duplicateBody.length, false);
    duplicateFrame.set(duplicateBody, 4);
    protocolError(() => decodeControlFrame(duplicateFrame), "invalid_message");
    const capPlusOne = new Uint8Array(4);
    new DataView(capPlusOne.buffer).setUint32(0, COMPUTER_USE_HOST_CONTROL_MAX_BYTES + 1);
    protocolError(() => new ControlFrameDecoder().push(capPlusOne), "frame_too_large");
  });

  test("binds PNG metadata to bytes, dimensions, digest, and exact generations", () => {
    const bytes = onePixelPng();
    const metadata = { attachmentId: "attachment-1", requestId: "request-1", hostGeneration: "host-1", driverGeneration: "driver-1", mime: "image/png", byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), width: 1, height: 1, coordinateSpace: "desktop_pixels" } as const;
    expect(parsePngAttachment(metadata, bytes)).toEqual({ metadata, bytes });
    protocolError(() => parsePngAttachment({ ...metadata, width: 2 }, bytes), "invalid_attachment");
    protocolError(() => parsePngAttachment({ ...metadata, sha256: "0".repeat(64) }, bytes), "invalid_attachment");

    const visualContract: ComputerUseHostContract = {
      ...contract,
      attachmentClass: "png",
      disclosureClass: "visual",
    };
    const attachedResult = {
      ...result(),
      contract: visualContract,
      attachment: metadata,
    } as const;
    expect(new ComputerUseHostResultGate(expectation(visualContract)).accept(attachedResult)).toEqual(attachedResult);
    for (const mismatched of [
      { ...metadata, requestId: "request-2" },
      { ...metadata, hostGeneration: "host-2" },
      { ...metadata, driverGeneration: "driver-2" },
    ]) protocolError(() => new ComputerUseHostResultGate(expectation(visualContract)).accept({
      ...attachedResult,
      attachment: mismatched,
    }), "invalid_message");
    protocolError(() => parseComputerUseHostControlMessage({
      ...result(),
      attachment: metadata,
    }), "invalid_message");
    protocolError(() => parseComputerUseHostControlMessage({
      ...attachedResult,
      contract: { ...visualContract, disclosureClass: "semantic" },
    }), "invalid_message");
    const frame = encodePngAttachmentFrame(metadata, bytes);
    for (let split = 1; split < frame.length; split += 1) {
      const decoder = new AttachmentFrameDecoder();
      expect(decoder.push(frame.subarray(0, split))).toEqual([]);
      expect(decoder.push(frame.subarray(split))).toEqual([{ metadata, bytes }]);
      decoder.finish();
    }
  });
});
