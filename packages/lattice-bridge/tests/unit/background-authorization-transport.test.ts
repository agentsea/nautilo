import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import type { BunPlugin, Loader } from "bun";
import ts from "typescript";
import {
  LatticeCrypto,
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceId,
  objectId,
  unixTimestamp,
} from "@nautilo/lattice-crypto";
import {
  backgroundWorkDescriptorDigestV1,
  encodeBackgroundWorkDescriptorV1,
  type BackgroundWorkDescriptorV1,
} from "@nautilo/lattice-crypto/wire";
import {
  BackgroundAuthorizationTransportError,
  MAX_BACKGROUND_AUTHORIZATION_REQUEST_DTO_BYTES_V1,
  decodeBackgroundAuthorizationDeviceRequestDtoV1,
  decodeBackgroundAuthorizationDeviceResponseDtoV1,
  encodeBackgroundAuthorizationDeviceRequestDtoV1,
  encodeBackgroundAuthorizationDeviceResponseDtoV1,
  fulfillProcessorBackgroundAuthorizationRequest,
  type BackgroundAuthorizationDeviceAuthority,
  type BackgroundAuthorizationDeviceRequest,
} from "../../src/device/background-authorization-client.ts";

const NOW = 1_800_000_000_000;

function deterministicCrypto(): LatticeCrypto {
  let next = 1;
  return new LatticeCrypto({
    bytes: (length) => Uint8Array.from(
      { length },
      () => next++ & 0xff,
    ),
  }, { now: () => NOW });
}

async function fixture(crypto: LatticeCrypto): Promise<Readonly<{
  descriptor: BackgroundWorkDescriptorV1;
  request: BackgroundAuthorizationDeviceRequest;
  authority: BackgroundAuthorizationDeviceAuthority;
}>> {
  const recipient = await crypto.generateEncryptionKeyPair();
  recipient.privateKey.fill(0);
  const outputId = objectId("journal-event-001");
  const descriptor: BackgroundWorkDescriptorV1 = {
    formatVersion: 1,
    requestId: "background-request-001",
    recipientGeneration: 7,
    workKind: "stenographer.extraction",
    workId: "journal-batch-001",
    namespaceId: namespaceId("namespace-room-001"),
    domainId: cryptoDomainId("domain-room-001"),
    subject: { kind: "processor", processorKind: "stenographer",
      processorVersion: 1, authorizationRevision: authorizationRevision(19) },
    purpose: "journal.extract",
    operations: ["decrypt", "encrypt"],
    source: { kind: "journal_range", startSequence: 41, endSequence: 45,
      rebuildGeneration: 3, fingerprint: new Uint8Array(32).fill(0x41) },
    inputObjectIds: [objectId("message-object-041")],
    outputObjectIds: [outputId],
    outputObjectMetadata: [{ objectId: outputId, objectType: "room_event",
      createdAt: unixTimestamp(NOW) }],
    maximumInputObjectCount: 1,
    maximumOutputObjectCount: 1,
    maximumPlaintextBytes: 128 * 1_024,
    maximumCiphertextBytes: 256 * 1_024,
    expectedDomainEpoch: domainEpoch(7),
    expectedNamespaceAccessRevision: accessRevision(11),
    expectedPolicyRevision: authorizationRevision(13),
    recipientKeyId: "recipient-key-001",
    recipientPublicKey: recipient.publicKey,
    issuedAt: NOW,
    notBefore: NOW,
    expiresAt: NOW + 300_000,
    idempotencyId: "background-idempotency-001",
  };
  const descriptorBytes = encodeBackgroundWorkDescriptorV1(descriptor);
  const issuer = crypto.generateSigningKeyPair();
  return {
    descriptor,
    request: { formatVersion: 1, descriptorBytes,
      descriptorHash: backgroundWorkDescriptorDigestV1(crypto, descriptor) },
    authority: {
      humanId: humanId("human-alice"), humanState: "active",
      deviceId: cryptoDeviceId("device-alice-browser"),
      deviceHumanId: humanId("human-alice"), deviceState: "active",
      deviceAuthorizationRevision: authorizationRevision(17),
      deviceSigningPublicKey: issuer.publicKey,
      deviceSigningPrivateKey: issuer.privateKey,
      namespaceId: descriptor.namespaceId, namespaceState: "active",
      membershipHumanId: humanId("human-alice"), membershipState: "active",
      namespaceAccessRevision: descriptor.expectedNamespaceAccessRevision,
      policyRevision: descriptor.expectedPolicyRevision,
      domainId: descriptor.domainId, domainState: "active",
      domainEpoch: descriptor.expectedDomainEpoch,
      processorKind: "stenographer", processorVersion: 1,
      processorState: "active",
      processorAuthorizationRevision: authorizationRevision(19),
      aiRoot: new Uint8Array(32).fill(0xa7),
    },
  };
}

function transportCode(error: unknown): string | undefined {
  return error instanceof BackgroundAuthorizationTransportError
    ? error.code : undefined;
}

function rewrite(bytes: Uint8Array, change: (value: Record<string, unknown>) => void):
  Uint8Array {
  const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  change(value);
  return new TextEncoder().encode(JSON.stringify(value));
}

describe("background authorization portable transport", () => {
  test("round trips canonical request and fulfillment bytes exactly", async () => {
    const crypto = deterministicCrypto();
    const value = await fixture(crypto);
    const requestBytes = encodeBackgroundAuthorizationDeviceRequestDtoV1(
      crypto, value.request,
    );
    const decodedRequest = decodeBackgroundAuthorizationDeviceRequestDtoV1(
      crypto, requestBytes,
    );
    expect(decodedRequest).toEqual(value.request);

    const fulfillment = await fulfillProcessorBackgroundAuthorizationRequest({
      crypto,
      request: decodedRequest,
      resolveCurrentAuthority: () => value.authority,
    });
    const responseBytes = encodeBackgroundAuthorizationDeviceResponseDtoV1(
      crypto, fulfillment,
    );
    expect(decodeBackgroundAuthorizationDeviceResponseDtoV1(
      crypto, responseBytes,
    )).toEqual(fulfillment);
  });

  test("round trips a typed refusal without an explanatory string", () => {
    const crypto = deterministicCrypto();
    const encoded = encodeBackgroundAuthorizationDeviceResponseDtoV1(crypto, {
      formatVersion: 1,
      requestId: "background-request-001",
      recipientGeneration: 7,
      code: "authority_unavailable",
    });
    expect(new TextDecoder().decode(encoded)).not.toContain("message");
    expect(decodeBackgroundAuthorizationDeviceResponseDtoV1(crypto, encoded))
      .toEqual({ formatVersion: 1,
        requestId: "background-request-001", recipientGeneration: 7,
        code: "authority_unavailable" });
  });

  test("rejects unsupported, unknown, duplicate, noncanonical and oversized DTOs", async () => {
    const crypto = deterministicCrypto();
    const { request } = await fixture(crypto);
    const encoded = encodeBackgroundAuthorizationDeviceRequestDtoV1(crypto, request);
    const cases: Array<readonly [Uint8Array, string]> = [
      [rewrite(encoded, (value) => { value["formatVersion"] = 2; }),
        "unsupported_version"],
      [rewrite(encoded, (value) => { value["extra"] = true; }), "malformed"],
      [new TextEncoder().encode(new TextDecoder().decode(encoded).replace(
        '"formatVersion":1', '"formatVersion":1,"formatVersion":1',
      )), "noncanonical"],
      [new TextEncoder().encode(` ${new TextDecoder().decode(encoded)}`),
        "noncanonical"],
      [new Uint8Array(
        MAX_BACKGROUND_AUTHORIZATION_REQUEST_DTO_BYTES_V1 + 1,
      ), "oversized"],
    ];
    for (const [candidate, code] of cases) {
      expect(() => decodeBackgroundAuthorizationDeviceRequestDtoV1(
        crypto, candidate,
      )).toThrow(BackgroundAuthorizationTransportError);
      try {
        decodeBackgroundAuthorizationDeviceRequestDtoV1(crypto, candidate);
      } catch (error) {
        expect(transportCode(error)).toBe(code);
      }
    }
  });

  test("rejects a UTF-8 BOM instead of silently stripping it", async () => {
    const crypto = deterministicCrypto();
    const { request } = await fixture(crypto);
    const encoded = encodeBackgroundAuthorizationDeviceRequestDtoV1(
      crypto, request,
    );
    const withBom = Uint8Array.from([0xef, 0xbb, 0xbf, ...encoded]);
    expect(() => decodeBackgroundAuthorizationDeviceRequestDtoV1(
      crypto, withBom,
    )).toThrow(BackgroundAuthorizationTransportError);
    try {
      decodeBackgroundAuthorizationDeviceRequestDtoV1(crypto, withBom);
    } catch (error) {
      expect(transportCode(error)).toBe("malformed");
    }
  });

  test("rejects an oversized outer request before hashing inner bytes", () => {
    let hashCalls = 0;
    const crypto = {
      hash: (_bytes: Uint8Array) => {
        hashCalls += 1;
        return new Uint8Array(32);
      },
    };
    expect(() => decodeBackgroundAuthorizationDeviceRequestDtoV1(
      crypto,
      new Uint8Array(MAX_BACKGROUND_AUTHORIZATION_REQUEST_DTO_BYTES_V1 + 1),
    )).toThrow(BackgroundAuthorizationTransportError);
    expect(hashCalls).toBe(0);
  });

  test("refusal coordinates use the canonical portable-ID grammar", () => {
    const crypto = deterministicCrypto();
    expect(() => encodeBackgroundAuthorizationDeviceResponseDtoV1(crypto, {
      formatVersion: 1,
      requestId: "contains spaces",
      recipientGeneration: 1,
      code: "authority_unavailable",
    })).toThrow(BackgroundAuthorizationTransportError);
  });

  test("rejects noncanonical base64url and stale outer coordinates", async () => {
    const crypto = deterministicCrypto();
    const { request } = await fixture(crypto);
    const encoded = encodeBackgroundAuthorizationDeviceRequestDtoV1(crypto, request);
    for (const candidate of [
      rewrite(encoded, (value) => {
        value["descriptorHashBase64url"] =
          `${String(value["descriptorHashBase64url"])}=`;
      }),
      rewrite(encoded, (value) => { value["recipientGeneration"] = 8; }),
      rewrite(encoded, (value) => { value["requestId"] = "stale-request"; }),
    ]) {
      expect(() => decodeBackgroundAuthorizationDeviceRequestDtoV1(
        crypto, candidate,
      )).toThrow(BackgroundAuthorizationTransportError);
    }
    try {
      decodeBackgroundAuthorizationDeviceRequestDtoV1(crypto,
        rewrite(encoded, (value) => { value["recipientGeneration"] = 8; }));
    } catch (error) {
      expect(transportCode(error)).toBe("stale_coordinates");
    }
  });

  test("leaf source import closure and bundle exclude platform owners", async () => {
    const sourceGraph = new Map<string, string>();
    const bundledSources = new Map<string, string>();
    const resolvedRuntimeImports: string[] = [];
    const unknownFirstPartyImports: string[] = [];
    const repositoryRoot = join(import.meta.dir, "../../../..");
    const firstPartyPackages = join(repositoryRoot, "packages");
    const cryptoBackgroundClient = join(repositoryRoot,
      "packages/lattice-crypto/src/background/client.ts");
    const resolveFirstParty = (from: string, specifier: string) => {
      if (specifier === "@nautilo/lattice-crypto/background") {
        return cryptoBackgroundClient;
      }
      if (specifier.startsWith(".")) return join(dirname(from), specifier);
      return null;
    };
    const collectSourceClosure = async (path: string): Promise<void> => {
      if (sourceGraph.has(path)) return;
      const source = await Bun.file(path).text();
      sourceGraph.set(path, source);
      const parsed = ts.createSourceFile(path, source,
        ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
      const dependencies: string[] = [];
      for (const statement of parsed.statements) {
        if (ts.isImportDeclaration(statement)) {
          const clause = statement.importClause;
          const namedImports = clause?.namedBindings !== undefined
            && ts.isNamedImports(clause.namedBindings)
            ? clause.namedBindings : undefined;
          const typeOnly = clause?.isTypeOnly === true
            || (clause?.name === undefined && namedImports !== undefined
              && namedImports.elements.every((element) => element.isTypeOnly));
          if (!typeOnly && ts.isStringLiteral(statement.moduleSpecifier)) {
            dependencies.push(statement.moduleSpecifier.text);
          }
        } else if (ts.isExportDeclaration(statement)
          && !statement.isTypeOnly
          && statement.moduleSpecifier !== undefined
          && ts.isStringLiteral(statement.moduleSpecifier)) {
          dependencies.push(statement.moduleSpecifier.text);
        }
      }
      for (const specifier of dependencies) {
        const resolved = resolveFirstParty(path, specifier);
        if (specifier.startsWith("@nautilo/") && resolved === null) {
          unknownFirstPartyImports.push(`${path} -> ${specifier}`);
        }
        if (resolved !== null && resolved.startsWith(firstPartyPackages)) {
          await collectSourceClosure(resolved);
        }
      }
    };
    const entrypoint = join(import.meta.dir,
      "../../src/device/background-authorization-client.ts");
    await collectSourceClosure(entrypoint);
    const captureLoadedSources: BunPlugin = {
      name: "capture-background-authorization-loaded-sources",
      setup(build) {
        const resolveRuntimeImport = async (args: {
          path: string;
          resolveDir: string;
        }) => {
          resolvedRuntimeImports.push(`${args.resolveDir} -> ${args.path}`);
          const path = args.path.startsWith(".")
            ? join(args.resolveDir, args.path)
            : await Bun.resolve(args.path, args.resolveDir);
          return { path, namespace: "portable-source" };
        };
        build.onResolve({ filter: /.*/u, namespace: "file" },
          resolveRuntimeImport);
        build.onResolve({ filter: /.*/u, namespace: "portable-source" },
          resolveRuntimeImport);
        build.onLoad({ filter: /.*/u, namespace: "portable-source" },
          async (args) => {
          const match = args.path.match(/\.(ts|tsx|js|jsx|mjs|cjs)$/u);
          if (match === null) {
            return { contents: await Bun.file(args.path).arrayBuffer(),
              loader: "file" };
          }
          const source = await Bun.file(args.path).text();
          bundledSources.set(args.path, source);
          const extension = match[1]!;
          const loader: Loader = extension === "tsx" ? "tsx"
            : extension === "ts" ? "ts"
              : extension === "jsx" ? "jsx" : "js";
          return { contents: source, loader };
          });
      },
    };
    const result = await Bun.build({
      entrypoints: [entrypoint],
      target: "browser",
      plugins: [captureLoadedSources],
    });
    expect(result.success).toBe(true);
    expect(result.logs).toEqual([]);
    expect(unknownFirstPartyImports).toEqual([]);
    expect([...sourceGraph.keys()]).toContain(cryptoBackgroundClient);
    expect([...sourceGraph.keys()]).not.toContain(join(repositoryRoot,
      "packages/lattice-crypto/src/index.ts"));
    expect([...sourceGraph.keys()]).not.toContain(join(repositoryRoot,
      "packages/lattice-crypto/src/wire.ts"));
    expect([...bundledSources.keys()]).toContain(entrypoint);
    expect([...bundledSources.keys()]).toContain(cryptoBackgroundClient);
    expect([...bundledSources.keys()]).not.toContain(join(repositoryRoot,
      "packages/lattice-crypto/src/crypto/index.ts"));
    expect([...bundledSources.keys()].some((path) =>
      path.includes("/node_modules/@noble/"))).toBe(true);
    expect(resolvedRuntimeImports.length).toBeGreaterThan(0);
    const forbiddenSpecifiers: string[] = [];
    const forbiddenGlobals: string[] = [];
    for (const [path, source] of bundledSources) {
      const kind = path.endsWith(".ts") ? ts.ScriptKind.TS
        : path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.JS;
      const parsed = ts.createSourceFile(path, source,
        ts.ScriptTarget.Latest, false, kind);
      const visit = (node: ts.Node): void => {
        let specifier: string | undefined;
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
          && node.moduleSpecifier !== undefined
          && ts.isStringLiteral(node.moduleSpecifier)) {
          specifier = node.moduleSpecifier.text;
        } else if (ts.isCallExpression(node)
          && (node.expression.kind === ts.SyntaxKind.ImportKeyword
            || (ts.isIdentifier(node.expression)
              && node.expression.text === "require"))
          && node.arguments.length === 1
          && ts.isStringLiteral(node.arguments[0]!)) {
          specifier = node.arguments[0].text;
        }
        if (specifier !== undefined
          && (specifier === "crypto" || specifier.startsWith("node:")
            || specifier === "electron" || specifier.startsWith("electron/")
            || specifier === "react" || specifier.startsWith("react/")
            || specifier === "@nautilo/db" || specifier.startsWith("@nautilo/db/")
            || specifier === "@nautilo/trust"
            || specifier.startsWith("@nautilo/trust/")
            || specifier.includes("/server/"))) {
          forbiddenSpecifiers.push(`${path} -> ${specifier}`);
        }
        if (ts.isPropertyAccessExpression(node)) {
          const directGlobal = ts.isIdentifier(node.expression)
            && ["Buffer", "window", "document", "indexedDB"]
              .includes(node.expression.text)
            ? node.expression.text : undefined;
          const globalThisProperty = ts.isIdentifier(node.expression)
            && node.expression.text === "globalThis"
            && ["Buffer", "window", "document", "indexedDB"]
              .includes(node.name.text)
            ? node.name.text : undefined;
          const globalName = directGlobal ?? globalThisProperty;
          if (globalName !== undefined) {
            forbiddenGlobals.push(`${path} -> ${globalName}`);
          }
        } else if (ts.isTypeOfExpression(node)
          && ts.isIdentifier(node.expression)
          && ["Buffer", "window", "document", "indexedDB"]
            .includes(node.expression.text)) {
          forbiddenGlobals.push(`${path} -> ${node.expression.text}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
    }
    expect(forbiddenSpecifiers).toEqual([]);
    expect(forbiddenGlobals).toEqual([]);
    const output = await result.outputs[0]!.text();
    expect(output).not.toMatch(/node:|electron|indexeddb|react|postgres|\.\/server\//iu);
  });
});
