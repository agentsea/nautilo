import { describe, expect, test } from "bun:test";
import type { PortableTransferAuthority } from "@nautilo/hosting";

import {
  RailwayPortableMaintenanceDescriptorProbeError,
  S3RailwayPortableMaintenanceDescriptorProbe,
  type RailwayPortableDescriptorObjectGet,
  type RailwayPortableDescriptorObjectHead,
  type RailwayPortableDescriptorObjectPortFactory,
} from "../../src/lib/railway-portable-maintenance-descriptor-probe";

const sha = "a".repeat(64);
const completedAt = "2026-08-12T10:00:00.000Z";
const authority: PortableTransferAuthority = {
  endpoint: "https://objects.example.test",
  region: "auto",
  bucket: "recovery",
  accessKeyId: "ACCESS_SECRET",
  secretAccessKey: "SECRET_SECRET",
  encryptionKey: new Uint8Array(32).fill(7),
};
const canonical = () => new TextEncoder().encode(JSON.stringify({
  format: "nautilo-recovery-v1",
  version: 1,
  operationId: "operation-1",
  objectId: "object-1",
  ciphertextSha256: sha,
  ciphertextBytes: 4096,
  sourceReleaseId: "release-1",
  completedAt,
}));

function body(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return { async *[Symbol.asyncIterator]() { yield bytes.slice(0, 17); yield bytes.slice(17); } };
}

function harness(options: {
  readonly bundle?: RailwayPortableDescriptorObjectHead | undefined;
  readonly descriptorHead?: RailwayPortableDescriptorObjectHead | undefined;
  readonly descriptorGet?: RailwayPortableDescriptorObjectGet | undefined;
  readonly failure?: Error;
} = {}) {
  const calls: string[] = [];
  const configs: Parameters<RailwayPortableDescriptorObjectPortFactory["create"]>[0][] = [];
  const bytes = canonical();
  const factory: RailwayPortableDescriptorObjectPortFactory = { create: (config) => {
    configs.push(structuredClone(config));
    return {
      headObject: async ({ key }) => {
        calls.push(`HEAD ${key}`);
        if (options.failure !== undefined) throw options.failure;
        return key.endsWith(".bundle")
          ? ("bundle" in options ? options.bundle : { contentType: "application/octet-stream", contentLength: 4096 })
          : ("descriptorHead" in options ? options.descriptorHead : { contentType: "application/json", contentLength: bytes.byteLength });
      },
      getObject: async ({ key }) => {
        calls.push(`GET ${key}`);
        return "descriptorGet" in options ? options.descriptorGet
          : { contentType: "application/json", contentLength: bytes.byteLength, body: body(bytes) };
      },
    };
  } };
  return { probe: new S3RailwayPortableMaintenanceDescriptorProbe(factory), calls, configs };
}

function input() {
  return { operationId: "operation-1", objectId: "object-1", authority: { ...authority }, prefix: "tenant/backup", sessionToken: "SESSION_SECRET" };
}

describe("S3RailwayPortableMaintenanceDescriptorProbe", () => {
  test("reads only the exact canonical descriptor key and verifies the bundle by HEAD", async () => {
    const value = harness();
    expect(await value.probe.observe(input())).toEqual({ state: "complete", descriptor: {
      operationId: "operation-1", objectId: "object-1", ciphertextSha256: sha, ciphertextBytes: 4096,
      sourceReleaseId: "release-1", completedAt,
    } });
    expect(value.calls).toEqual([
      "HEAD tenant/backup/nautilo-recovery-v1/operation-1/object-1.bundle",
      "HEAD tenant/backup/nautilo-recovery-v1/operation-1/object-1.complete.json",
      "GET tenant/backup/nautilo-recovery-v1/operation-1/object-1.complete.json",
    ]);
    expect(value.calls.some((call) => call.startsWith("GET") && call.endsWith(".bundle"))).toBe(false);
    expect(value.configs).toEqual([{ endpoint: "https://objects.example.test/", region: "auto",
      accessKeyId: "ACCESS_SECRET", secretAccessKey: "SECRET_SECRET", sessionToken: "SESSION_SECRET" }]);
  });

  test("distinguishes exact absence from incomplete remote state", async () => {
    expect(await harness({ bundle: undefined, descriptorHead: undefined }).probe.observe(input())).toEqual({ state: "not-found" });
    expect(await harness({ descriptorHead: undefined }).probe.observe(input())).toEqual({ state: "inconsistent" });
    expect(await harness({ bundle: undefined }).probe.observe(input())).toEqual({ state: "inconsistent" });
  });

  test("rejects noncanonical schema, identity, digest, content metadata, and length", async () => {
    const variants: Uint8Array[] = [
      new TextEncoder().encode(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(canonical())), objectId: "other" })),
      new TextEncoder().encode(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(canonical())), ciphertextSha256: "A".repeat(64) })),
      new TextEncoder().encode(` ${new TextDecoder().decode(canonical())}`),
      new TextEncoder().encode(new TextDecoder().decode(canonical()).replace("\"version\":1", "\"version\":1,\"extra\":true")),
    ];
    for (const bytes of variants) {
      expect(await harness({ descriptorGet: { contentType: "application/json", contentLength: bytes.byteLength, body: body(bytes) } }).probe.observe(input()))
        .toEqual({ state: "inconsistent" });
    }
    expect(await harness({ descriptorGet: { contentType: "text/plain", contentLength: canonical().byteLength, body: body(canonical()) } }).probe.observe(input()))
      .toEqual({ state: "inconsistent" });
    expect(await harness({ descriptorGet: { contentType: "application/json", contentLength: canonical().byteLength + 1, body: body(canonical()) } }).probe.observe(input()))
      .toEqual({ state: "inconsistent" });
    expect(await harness({ bundle: { contentType: "application/octet-stream", contentLength: 4097 } }).probe.observe(input()))
      .toEqual({ state: "inconsistent" });
  });

  test("snapshots authority, identity, prefix, session token, and factory before awaiting", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    let captured: Parameters<RailwayPortableDescriptorObjectPortFactory["create"]>[0] | undefined;
    const factory: RailwayPortableDescriptorObjectPortFactory = { create(config) { captured = { ...config }; return {
      headObject: async ({ key }) => { calls.push(key); await gate; return key.endsWith(".bundle")
        ? { contentType: "application/octet-stream", contentLength: 4096 }
        : { contentType: "application/json", contentLength: canonical().byteLength }; },
      getObject: async () => ({ contentType: "application/json", contentLength: canonical().byteLength, body: body(canonical()) }),
    }; } };
    const probe = new S3RailwayPortableMaintenanceDescriptorProbe(factory);
    const mutable = input();
    const pending = probe.observe(mutable);
    mutable.operationId = "mutated"; mutable.objectId = "mutated"; mutable.prefix = "mutated";
    mutable.sessionToken = "MUTATED_SECRET"; mutable.authority.endpoint = "https://mutated.example.test";
    release();
    expect((await pending).state).toBe("complete");
    expect(calls[0]).toBe("tenant/backup/nautilo-recovery-v1/operation-1/object-1.bundle");
    expect(captured).toMatchObject({ endpoint: "https://objects.example.test/", sessionToken: "SESSION_SECRET" });
  });

  test("uses one redacted error for invalid input, factory failure, and secret-bearing transport failure", async () => {
    const invalid = input(); invalid.authority.endpoint = "https://user:password@objects.example.test";
    for (const promise of [
      harness().probe.observe(invalid),
      new S3RailwayPortableMaintenanceDescriptorProbe({ create: () => { throw new Error("SECRET_SECRET"); } }).observe(input()),
      harness({ failure: new Error("SECRET_SECRET SESSION_SECRET") }).probe.observe(input()),
    ]) {
      let error: unknown;
      try { await promise; } catch (cause) { error = cause; }
      expect(error).toBeInstanceOf(RailwayPortableMaintenanceDescriptorProbeError);
      expect(String(error)).toBe("RailwayPortableMaintenanceDescriptorProbeError: Railway portable maintenance descriptor probe failed");
      expect(JSON.stringify(error)).not.toContain("SECRET");
    }
  });

  test("enforces canonical storage byte boundaries before constructing a transport", async () => {
    const exact = input();
    exact.authority.region = `a${"b".repeat(63)}`;
    exact.prefix = `${"a".repeat(128)}/${"b".repeat(127)}`;
    exact.authority.accessKeyId = "a".repeat(2 * 1024);
    exact.authority.secretAccessKey = "s".repeat(8 * 1024);
    exact.sessionToken = "t".repeat(16 * 1024);
    expect((await harness().probe.observe(exact)).state).toBe("complete");

    const variants = [
      { ...input(), authority: { ...authority, region: `a${"b".repeat(64)}` } },
      { ...input(), authority: { ...authority, region: `a${"b".repeat(62)}é` } },
      { ...input(), prefix: `${"a".repeat(128)}/${"b".repeat(128)}` },
      { ...input(), prefix: `${"a".repeat(128)}/${"b".repeat(125)}é` },
      { ...input(), authority: { ...authority, accessKeyId: "é".repeat(1025) } },
      { ...input(), authority: { ...authority, secretAccessKey: "é".repeat(4097) } },
      { ...input(), sessionToken: "é".repeat(8193) },
    ];
    for (const value of variants) {
      let error: unknown;
      try { await harness().probe.observe(value); } catch (cause) { error = cause; }
      expect(error).toBeInstanceOf(RailwayPortableMaintenanceDescriptorProbeError);
    }
  });
});
