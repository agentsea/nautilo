import { AsyncLocalStorage } from "node:async_hooks";
import type { DurableModelExposureDependency } from "@nautilo/reflection/durable";
import type { PersonalMemoryEvidencePort } from "@nautilo/reflection-bridge/server";

type Scope = Readonly<{
  readonly ports: readonly PersonalMemoryEvidencePort[];
}>;

const storage = new AsyncLocalStorage<Scope>();

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonical(child)]));
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function combine(
  ports: readonly PersonalMemoryEvidencePort[],
): PersonalMemoryEvidencePort {
  const unique = [...new Set(ports)];
  const resolveOne = async <Value>(
    read: (port: PersonalMemoryEvidencePort) => Promise<Value | null>,
  ): Promise<Value | null> => {
    let result: Value | null = null;
    for (const port of unique) {
      const value = await read(port);
      if (value === null) continue;
      // Same-Room questions commonly share one exact source or audience.
      // Every scope was still consulted; only conflicting current answers fail.
      if (result !== null) {
        if (!equal(result, value)) return null;
        continue;
      }
      result = value;
    }
    return result;
  };
  return Object.freeze({
    readRecord: (dependency: Extract<DurableModelExposureDependency, {kind: "record"}>) => resolveOne(port => port.readRecord(dependency)),
    readSource: (dependency: Extract<DurableModelExposureDependency, {kind: "source"}>) => resolveOne(port => port.readSource(dependency)),
    readAudience: (leaf: string) => resolveOne(port => port.readAudience(leaf)),
  });
}

/**
 * Installs only process-local, question-owned evidence for the duration of one
 * provider call. Nested protected questions compose into a strict batch port.
 */
export function runWithProtectedMemoryEvidence<Value>(
  port: PersonalMemoryEvidencePort,
  run: () => Promise<Value>,
): Promise<Value> {
  const outer = storage.getStore();
  return storage.run(
    Object.freeze({ ports: Object.freeze([...(outer?.ports ?? []), port]) }),
    run,
  );
}

/** Present only inside a live protected question's provider callback. */
export function getCurrentProtectedMemoryEvidence():
  PersonalMemoryEvidencePort | undefined {
  const current = storage.getStore();
  return current === undefined ? undefined : combine(current.ports);
}
