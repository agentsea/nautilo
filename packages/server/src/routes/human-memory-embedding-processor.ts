import {
  embedTextWithProvenance,
  getProtectedMemoryEmbeddingConfiguration,
  getMemoryEmbeddingDisclosure,
} from "@nautilo/agent";
import {
  assertMemoryEmbeddingDisclosureV2,
  sameMemoryEmbeddingDisclosureV2,
  type MemoryEmbeddingDisclosureV2,
} from "@nautilo/lattice-crypto/wire";
import {
  createMemoryForegroundEmbeddingProcessor,
  MEMORY_EMBEDDING_DIMENSIONS,
} from "@nautilo/lattice-bridge";

/** The existing configured provider is the only disclosure destination.
 * Request input cannot select an endpoint or silently choose a new provider. */
export function createHumanMemoryEmbeddingProcessor(input: Readonly<{
  configuration?: typeof getProtectedMemoryEmbeddingConfiguration;
  disclosure?: () => MemoryEmbeddingDisclosureV2;
  embed?: typeof embedTextWithProvenance;
  now?: () => number;
}> = {}) {
  const configuration = input.configuration ?? getProtectedMemoryEmbeddingConfiguration;
  const embed = input.embed ?? embedTextWithProvenance;
  const disclosure = input.disclosure ?? (input.configuration === undefined
    ? getMemoryEmbeddingDisclosure
    : () => ({ contractVersion: 2 as const,
      canonicalSpace: descriptor(), processingRoute: { transport: "direct" as const } }));
  const descriptor = () => {
    const configured = configuration();
    if (configured.dimensions !== MEMORY_EMBEDDING_DIMENSIONS) {
      throw new TypeError("The configured Memory embedding dimensions are unavailable");
    }
    return Object.freeze({ ...configured, dimensions: MEMORY_EMBEDDING_DIMENSIONS });
  };
  const descriptorV2 = (): MemoryEmbeddingDisclosureV2 => {
    const value = disclosure();
    assertMemoryEmbeddingDisclosureV2(value);
    return value;
  };
  return Object.freeze({
    descriptor,
    descriptorV2,
    processor: createMemoryForegroundEmbeddingProcessor({
      now: input.now ?? Date.now,
      provider: { async embed(request) {
        const expected = descriptor();
        const currentDisclosure = descriptorV2();
        if (expected.provider !== request.requestedProvider
          || expected.model !== request.requestedModel
          || expected.dimensions !== request.dimensions) {
          throw new TypeError("The approved Memory embedding configuration changed");
        }
        if (request.embeddingDisclosure === undefined) {
          if (currentDisclosure.processingRoute.transport !== "direct") {
            throw new TypeError("A fresh Memory marketplace disclosure is required");
          }
        } else if (!sameMemoryEmbeddingDisclosureV2(
          currentDisclosure, request.embeddingDisclosure,
        )) {
          throw new TypeError("The approved Memory processing route changed");
        }
        // The canonical provider owner rechecks this expectation before sending
        // any bytes, including when configuration changes between these calls.
        return embed(request.plaintext, request.signal, {
          ...expected,
          ...(request.embeddingDisclosure === undefined ? {}
            : { disclosure: request.embeddingDisclosure }),
        });
      } },
    }),
  });
}
