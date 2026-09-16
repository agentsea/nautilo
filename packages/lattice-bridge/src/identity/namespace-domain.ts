import {
  namespaceId,
  type CryptoDomainId,
  type NamespaceId,
} from "@nautilo/lattice-crypto";
import {
  productIdIsValid,
  type NautiloNamespaceId,
  type TranslationResult,
} from "./product-ids.ts";
import {
  translateParticipants,
  type ExactHumanSet,
  type ProductParticipantFact,
} from "./participants.ts";

export interface NamespaceDomainTranslationInput {
  readonly namespaceId: NautiloNamespaceId;
  readonly participants: readonly ProductParticipantFact[];
}

/**
 * Product facts sufficient to look up or create a Crypto Domain. Deliberately
 * absent is a Domain ID: a digest never grants authority to infer one.
 */
export interface NamespaceDomainCoordinates {
  readonly productNamespaceId: NautiloNamespaceId;
  readonly namespaceId: NamespaceId;
  readonly exactHumanSet: ExactHumanSet;
}

/**
 * A resolved persistence reference. Later storage code may construct this only
 * after matching the exact canonical Human set, never from a digest alone.
 */
export interface NamespaceCryptoDomainReference
  extends NamespaceDomainCoordinates {
  readonly domainId: CryptoDomainId;
}

export function translateNamespaceId(
  value: NautiloNamespaceId,
): TranslationResult<NamespaceId> {
  if (!productIdIsValid(value)) {
    return {
      ok: false,
      error: {
        code: "invalid_product_id",
        message: "A Namespace ID must be a canonical lowercase UUID",
        entityKind: "namespace",
        value,
      },
    };
  }
  return { ok: true, value: namespaceId(value) };
}

export function translateNamespaceDomainCoordinates(
  input: NamespaceDomainTranslationInput,
): TranslationResult<NamespaceDomainCoordinates> {
  if (
    typeof input !== "object"
    || input === null
    || Array.isArray(input)
    || Object.keys(input).length !== 2
    || !Object.hasOwn(input, "namespaceId")
    || !Object.hasOwn(input, "participants")
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_namespace_domain_input",
        message:
          "Namespace Domain translation requires exact Namespace and participant facts",
        value: input,
      },
    };
  }
  const translatedNamespace = translateNamespaceId(input.namespaceId);
  if (!translatedNamespace.ok) return translatedNamespace;
  const exactHumanSet = translateParticipants(input.participants);
  if (!exactHumanSet.ok) return exactHumanSet;
  return {
    ok: true,
    value: {
      productNamespaceId: input.namespaceId,
      namespaceId: translatedNamespace.value,
      exactHumanSet: exactHumanSet.value,
    },
  };
}
