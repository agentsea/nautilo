import { describe, expect, test } from "bun:test";
import { createAnchorSchemaFixtureFiles } from "../../testkit/schema-fixtures";
import {
  evaluateCompatibility,
} from "../../src/compatibility-contract";
import { observeProtocolSchemas } from "../../src/schema-observation";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const limits = {
  maxFiles: 2, maxTotalBytes: 1_000, maxFileBytes: 900,
  maxJsonDepth: 8, maxJsonNodes: 100,
};

describe("observeProtocolSchemas", () => {
  test("reproduces compatible immutable evidence from the anchored schema set", () => {
    const files = createAnchorSchemaFixtureFiles();
    const result = observeProtocolSchemas(
      files,
      undefined,
      null,
    );
    expect(evaluateCompatibility(result)).toMatchObject({
      state: "compatible_uncertified",
      reasons: [],
    });
    const reversed = observeProtocolSchemas([...files].reverse());
    expect(evaluateCompatibility(reversed)).toMatchObject({
      state: "compatible_uncertified",
      reasons: [],
    });
    expect(reversed.observation).toEqual(result.observation);
  });

  test("does not certify a self-declared version manifest", () => {
    const spoof = observeProtocolSchemas([{
      relativePath: "manifest.json",
      bytes: bytes({
        codexVersion: "0.139.0",
        cliReportedVersion: "codex-cli 0.139.0",
        package: { version: "0.139.0" },
      }),
    }], limits);
    expect(evaluateCompatibility(spoof).state).not.toBe("certified");
  });

  test("extracts evaluator members/fields and canonicalizes object/file order", () => {
    const client = {
      title: "ClientRequest",
      oneOf: [{ properties: { method: { enum: ["initialize"] } } }],
      definitions: {
        InitializeParams: {
          type: "object", required: ["clientInfo"],
          properties: { clientInfo: { type: "object" } },
        },
      },
    };
    const response = {
      title: "DynamicToolCallResponse", type: "object",
      required: ["success"], properties: { success: { type: "boolean" } },
    };
    const one = observeProtocolSchemas([
      { relativePath: "b.json", bytes: bytes(response) },
      { relativePath: "a.json", bytes: bytes(client) },
    ], limits);
    const two = observeProtocolSchemas([
      { relativePath: "a.json", bytes: bytes({ definitions: client.definitions, oneOf: client.oneOf, title: client.title }) },
      { relativePath: "b.json", bytes: bytes({ properties: response.properties, required: response.required, type: response.type, title: response.title }) },
    ], limits);
    expect(one.schemaFingerprint).toBe(two.schemaFingerprint);
    expect(one.observation.members["client_request"]).toEqual(["initialize"]);
    expect(one.observation.fields["InitializeParams.clientInfo"]).toEqual({
      required: true, kinds: ["object"],
    });
  });

  test("observes duplicate titled variants independently of JSON object order", () => {
    const compatible = {
      title: "AdditionalPermissionProfile",
      type: "object",
      properties: { network: { type: "object" } },
    };
    const incompatible = {
      title: "AdditionalPermissionProfile",
      type: "object",
      properties: { network: { type: "string" } },
    };
    const first = observeProtocolSchemas([
      {
        relativePath: "schema.json",
        bytes: bytes({ definitions: { ZVariant: incompatible, AVariant: compatible } }),
      },
    ], limits);
    const second = observeProtocolSchemas([
      {
        relativePath: "schema.json",
        bytes: bytes({ definitions: { AVariant: compatible, ZVariant: incompatible } }),
      },
    ], limits);

    expect(first.observation.fields["AdditionalPermissionProfile.network"]).toEqual({
      required: false,
      kinds: ["object"],
    });
    expect(second.observation.fields).toEqual(first.observation.fields);
  });

  test("enforces every portable input limit at N and N+1", () => {
    const tiny = bytes({});
    expect(() => observeProtocolSchemas([
      { relativePath: "a.json", bytes: tiny },
      { relativePath: "b.json", bytes: tiny },
    ], limits)).not.toThrow();
    expect(() => observeProtocolSchemas([
      { relativePath: "a.json", bytes: tiny },
      { relativePath: "b.json", bytes: tiny },
      { relativePath: "c.json", bytes: tiny },
    ], limits)).toThrow();
    expect(() => observeProtocolSchemas([{ relativePath: "../a.json", bytes: tiny }], limits)).toThrow();
    expect(() => observeProtocolSchemas([
      { relativePath: "a.json", bytes: tiny },
      { relativePath: "a.json", bytes: tiny },
    ], limits)).toThrow();
    const exactFile = new TextEncoder().encode(`{${" ".repeat(898)}}`);
    expect(exactFile.byteLength).toBe(900);
    expect(() => observeProtocolSchemas([{ relativePath: "a.json", bytes: exactFile }], limits)).not.toThrow();
    expect(() => observeProtocolSchemas([{
      relativePath: "a.json",
      bytes: new TextEncoder().encode(`{${" ".repeat(899)}}`),
    }], limits)).toThrow();
    expect(() => observeProtocolSchemas([
      { relativePath: "a.json", bytes: tiny },
      { relativePath: "b.json", bytes: tiny },
    ], { ...limits, maxTotalBytes: 4 })).not.toThrow();
    expect(() => observeProtocolSchemas([
      { relativePath: "a.json", bytes: tiny },
      { relativePath: "b.json", bytes: tiny },
    ], { ...limits, maxTotalBytes: 3 })).toThrow();
    expect(() => observeProtocolSchemas([{ relativePath: "a.json", bytes: bytes([]) }], limits)).toThrow();
    expect(() => observeProtocolSchemas([{ relativePath: "a.json", bytes: new TextEncoder().encode("{") }], limits)).toThrow();
  });

  test("enforces depth and aggregate node limits", () => {
    expect(() => observeProtocolSchemas([{ relativePath: "a.json", bytes: bytes({ a: {} }) }], {
      ...limits, maxJsonDepth: 1,
    })).not.toThrow();
    expect(() => observeProtocolSchemas([{ relativePath: "a.json", bytes: bytes({ a: { b: {} } }) }], {
      ...limits, maxJsonDepth: 1,
    })).toThrow();
    expect(() => observeProtocolSchemas([
      { relativePath: "a.json", bytes: bytes({ a: 1 }) },
      { relativePath: "b.json", bytes: bytes({}) },
    ], { ...limits, maxJsonNodes: 3 })).not.toThrow();
    expect(() => observeProtocolSchemas([
      { relativePath: "a.json", bytes: bytes({ a: 1 }) },
      { relativePath: "b.json", bytes: bytes({ b: 1 }) },
    ], { ...limits, maxJsonNodes: 3 })).toThrow();
  });

  test("derives ordinary requiredness and limits exceptions to proven serde shapes", () => {
    const schema: {
      title: string;
      definitions: Record<string, {
        type: string;
        required?: string[];
        properties: Record<string, {
          type: string | string[];
          default?: boolean;
        }>;
      }>;
    } = {
      title: "ClientRequest",
      definitions: {
        TurnStartParams: {
          type: "object",
          required: ["threadId"],
          properties: { threadId: { type: "string" } },
        },
        ThreadStartParams: {
          type: "object",
          properties: { cwd: { type: ["string", "null"] } },
        },
        InitializeCapabilities: {
          type: "object",
          properties: { experimentalApi: { type: "boolean", default: false } },
        },
      },
    };
    const anchored = observeProtocolSchemas([
      { relativePath: "schema.json", bytes: bytes(schema) },
    ], limits).observation;
    expect(anchored.fields["TurnStartParams.threadId"]?.required).toBe(true);
    expect(anchored.fields["ThreadStartParams.cwd"]?.required).toBe(false);
    expect(anchored.fields["InitializeCapabilities.experimentalApi"]?.required).toBe(false);
    schema.definitions["TurnStartParams"]!.required = [];
    schema.definitions["ThreadStartParams"]!.required = ["cwd"];
    delete schema.definitions["InitializeCapabilities"]!
      .properties["experimentalApi"]!.default;
    const drifted = observeProtocolSchemas([
      { relativePath: "schema.json", bytes: bytes(schema) },
    ], limits).observation;
    expect(drifted.fields["TurnStartParams.threadId"]?.required).toBe(false);
    expect(drifted.fields["ThreadStartParams.cwd"]?.required).toBe(true);
    expect(drifted.fields["InitializeCapabilities.experimentalApi"]?.required).toBe(false);
  });

  test("rejects excessive lexical depth before malformed JSON can be parsed", () => {
    const tooDeepAndMalformed = new TextEncoder().encode('{"a":{"b":{"c":');
    expect(() => observeProtocolSchemas([{
      relativePath: "schema.json",
      bytes: tooDeepAndMalformed,
    }], { ...limits, maxJsonDepth: 1 })).toThrow("depth limit");
  });
});
