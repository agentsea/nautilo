import {
  preflightOoxmlArchive,
  type OoxmlArchivePreflightLimits,
} from "./archive-preflight";
import type { OoxmlDestroyable, OoxmlLoadOwner } from "./lifecycle";

/**
 * An opaque, preflight-approved OOXML source. The master buffer is deliberately
 * private to this module; parser hosts can receive only one lifecycle-owned
 * disposable clone.
 */
const ooxmlByteSourceBrand: unique symbol = Symbol("OoxmlByteSource");

export type OoxmlByteSource = Readonly<{
  byteLength: number;
  signal: AbortSignal;
  deadlineAt: number;
  readonly [ooxmlByteSourceBrand]: true;
}>;

export interface CreateOoxmlByteSourceOptions {
  readonly bytes: ArrayBuffer;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  /** The host supplies its own archive limits; this package has no default. */
  readonly archivePreflight: OoxmlArchivePreflightLimits;
}

export type CreateOoxmlByteSourceResult =
  | { readonly kind: "ready"; readonly source: OoxmlByteSource }
  | { readonly kind: "invalid_archive" };

const masterBytesBySource = new WeakMap<OoxmlByteSource, ArrayBuffer>();

/**
 * Captures an already-authorized parser source after the host's zero-copy
 * archive preflight. This neither acquires bytes nor decides host limits.
 */
export function createOoxmlByteSource(
  options: CreateOoxmlByteSourceOptions,
): CreateOoxmlByteSourceResult {
  if (!preflightOoxmlArchive(options.bytes, options.archivePreflight).ok)
    return { kind: "invalid_archive" };
  const source = Object.freeze({
    byteLength: options.bytes.byteLength,
    signal: options.signal,
    deadlineAt: options.deadlineAt,
    [ooxmlByteSourceBrand]: true as const,
  });
  masterBytesBySource.set(source, options.bytes);
  return { kind: "ready", source };
}

/**
 * Gives the parser one disposable clone exactly at handoff. A forged opaque
 * source takes the existing lifecycle-owned sanitized-error path instead.
 */
export function runOoxmlLoadWithParserBytes<T extends OoxmlDestroyable>(
  owner: OoxmlLoadOwner,
  source: OoxmlByteSource,
  viewer: T,
  load: (viewer: T, parserBytes: ArrayBuffer) => Promise<void>,
  handlers: { onReady: (viewer: T) => void; onError: (message: string) => void },
): number {
  const master = masterBytesBySource.get(source);
  if (master)
    return owner.runWithParserBytes(viewer, master, load, handlers);
  return owner.run(
    viewer,
    () => {
      throw new Error("OOXML byte source is unavailable.");
    },
    handlers,
  );
}
