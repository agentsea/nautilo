import type { DurableSourceDependency } from "@nautilo/reflection/durable";
import type {
  SyntheticRecordEvidenceReaderPort,
  SyntheticSourceEvidenceResult,
} from "@nautilo/reflection/search";

export type CanonicalRecordSourceReadResult =
  | Readonly<{
      status: "available";
      kind: "memory" | "message" | "observation";
      content: string;
    }>
  | Readonly<{ status: "changed" }>
  | Readonly<{ status: "unavailable" }>;

/** Selected-mode exact source owner; implementations must never fallback. */
export interface CanonicalRecordSourceReadPort {
  readExact(input: Readonly<{
    dependency: DurableSourceDependency;
    evidenceBindingRef: string;
    returnedBytesMaximum: number;
    signal?: AbortSignal;
  }>): Promise<CanonicalRecordSourceReadResult>;
}

export interface RecordSourceInvalidationPort {
  admit(input: Readonly<{
    dependency: DurableSourceDependency;
    reason: "changed" | "unavailable";
  }>): Promise<void>;
}

function returnedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** Exact revision/auth revalidation before any Memory or Message body leaves its owner. */
export class ExactRecordSourceEvidenceReader
implements SyntheticRecordEvidenceReaderPort {
  constructor(private readonly ports: Readonly<{
    source: CanonicalRecordSourceReadPort;
    invalidation: RecordSourceInvalidationPort;
  }>) {}

  async read(input: Parameters<SyntheticRecordEvidenceReaderPort["read"]>[0]):
  Promise<SyntheticSourceEvidenceResult> {
    if (!input.sourceDependency.authorityBearing) {
      return { status: "unavailable", reason: "integrity_failure" };
    }
    const result = await this.ports.source.readExact({
      dependency: input.sourceDependency,
      evidenceBindingRef: input.evidenceBindingRef,
      returnedBytesMaximum: input.returnedBytesRemaining,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (result.status === "changed") {
      await this.ports.invalidation.admit({
        dependency: input.sourceDependency,
        reason: "changed",
      });
      return { status: "unavailable", reason: "source_changed" };
    }
    if (result.status === "unavailable") {
      await this.ports.invalidation.admit({
        dependency: input.sourceDependency,
        reason: "unavailable",
      });
      return { status: "unavailable", reason: "source_unavailable" };
    }
    const evidence = {
      evidenceRef: `exact-${result.kind}-evidence`,
      kind: result.kind,
      content: result.content,
      returnedUtf8Bytes: new TextEncoder().encode(result.content).byteLength,
    } as const;
    if (returnedBytes(evidence) > input.returnedBytesRemaining) {
      return { status: "unavailable", reason: "capacity_exceeded" };
    }
    return { status: "available", evidence };
  }
}
