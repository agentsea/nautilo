/**
 * Runtime implementations required by `kdbxweb` in Electron's main process.
 *
 * Published `kdbxweb 2.1.1` falls back to constructing `xmldom` with the
 * pre-0.9 object-shaped error handler when no DOM globals exist. Supplying the
 * audited parser and serializer through the standard globals makes kdbxweb use
 * its browser-compatible path instead. Existing host implementations always
 * win; this module only fills missing globals.
 */

import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

import { setKdbxArgon2Impl } from "./argon2-impl";

interface OptionalDomGlobals {
  DOMParser?: unknown;
  XMLSerializer?: unknown;
}

class StrictKdbxDOMParser extends DOMParser {
  constructor() {
    super({
      onError: (level, message) => {
        throw new Error(`${level}: ${message}`);
      },
    });
  }
}

let installed = false;

export function setMissingKdbxDomGlobals(
  runtimeGlobals: OptionalDomGlobals,
): void {
  runtimeGlobals.DOMParser ??= StrictKdbxDOMParser;
  runtimeGlobals.XMLSerializer ??= XMLSerializer;
}

export function setKdbxRuntimeImpls(): void {
  if (installed) return;

  setMissingKdbxDomGlobals(globalThis as OptionalDomGlobals);
  setKdbxArgon2Impl();

  installed = true;
}
