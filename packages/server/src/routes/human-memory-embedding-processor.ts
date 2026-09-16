import {
  embedTextWithProvenance,
  getProtectedMemoryEmbeddingConfiguration,
} from "@nautilo/agent";
import {
  createMemoryForegroundEmbeddingProcessor,
  MEMORY_EMBEDDING_DIMENSIONS,
} from "@nautilo/lattice-bridge";

/** The existing configured provider is the only disclosure destination.
 * Request input cannot select an endpoint or silently choose a new provider. */
export function createHumanMemoryEmbeddingProcessor(input: Readonly<{
  configuration?: typeof getProtectedMemoryEmbeddingConfiguration;
  embed?: typeof embedTextWithProvenance;
  now?: () => number;
}> = {}) {
  const configuration = input.configuration ?? getProtectedMemoryEmbeddingConfiguration;
  const embed = input.embed ?? embedTextWithProvenance;
  const descriptor = () => {
    const configured = configuration();
    if (configured.dimensions !== MEMORY_EMBEDDING_DIMENSIONS) {
      throw new TypeError("The configured Memory embedding dimensions are unavailable");
    }
    return Object.freeze({ ...configured, dimensions: MEMORY_EMBEDDING_DIMENSIONS });
  };
  return Object.freeze({
    descriptor,
    processor: createMemoryForegroundEmbeddingProcessor({
      now: input.now ?? Date.now,
      provider: { async embed(request) {
        const expected = descriptor();
        if (expected.provider !== request.requestedProvider
          || expected.model !== request.requestedModel
          || expected.dimensions !== request.dimensions) {
          throw new TypeError("The approved Memory embedding configuration changed");
        }
        // The canonical provider owner rechecks this expectation before sending
        // any bytes, including when configuration changes between these calls.
        return embed(request.plaintext, request.signal, expected);
      } },
    }),
  });
}
