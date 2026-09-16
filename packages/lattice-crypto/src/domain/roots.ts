import {
  concatV2,
  encodeU64,
  frameText,
} from "../format/v2-primitives.ts";
import {
  type CryptoDomainId,
  type DomainEpoch,
  assertPortableId,
  assertU64Counter,
} from "../v2-types/ids.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

export const HUMAN_DOMAIN_ROOT_EXPORTER_LABEL =
  "nautilo/lattice-crypto/human-domain-root/v2";
export const AI_DOMAIN_ROOT_EXPORTER_LABEL =
  "nautilo/lattice-crypto/ai-domain-root/v2";
export const DOMAIN_ROOT_BYTES = 32;

export type DomainRootClass = "human" | "ai";

export type DomainExporter = (
  label: string,
  context: Uint8Array,
  length: number,
) => Promise<Uint8Array>;

export function domainRootExporterContext(
  domainId: CryptoDomainId,
  epoch: DomainEpoch,
): Uint8Array {
  assertPortableId("Crypto Domain id", domainId);
  assertU64Counter("Domain epoch", epoch);
  return concatV2(frameText(domainId), encodeU64(epoch));
}

export async function exportDomainRoot(
  keyClass: DomainRootClass,
  domainId: CryptoDomainId,
  epoch: DomainEpoch,
  exporter: DomainExporter,
): Promise<Uint8Array> {
  let label: string;
  switch (keyClass) {
    case "human":
      label = HUMAN_DOMAIN_ROOT_EXPORTER_LABEL;
      break;
    case "ai":
      label = AI_DOMAIN_ROOT_EXPORTER_LABEL;
      break;
    default:
      throw new RangeError("Domain root class is unsupported");
  }
  const root = await exporter(
    label,
    domainRootExporterContext(domainId, epoch),
    DOMAIN_ROOT_BYTES,
  );
  try {
    if (!(root instanceof Uint8Array) || root.length !== DOMAIN_ROOT_BYTES) {
      throw new RangeError(
        `Domain exporter must return exactly ${DOMAIN_ROOT_BYTES} bytes`,
      );
    }
    return copyOwnedBytesV2(root);
  } finally {
    if (root instanceof Uint8Array) root.fill(0);
  }
}
