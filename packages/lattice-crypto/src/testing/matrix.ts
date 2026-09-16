import { DummyGroupProvider } from "../group/dummy.ts";
import { MlsGroupProvider } from "../group/mls.ts";
import { OpenMlsGroupProvider } from "../group/openmls.ts";
import { EnumerationScheme } from "../lattice/enumeration.ts";
import type { WorldConfig } from "./world.ts";

/**
 * The interchangeability matrix. Every scenario / conformance test runs
 * against every combination here. A test passing across all rows IS the proof
 * that the swap axes are interchangeable — the dummy group and REAL ts-mls must
 * behave identically from the lattice's point of view.
 *
 * {dummy, ts-mls} x {enumeration}. A v2 scheme (item 6) will add a column.
 */
export const matrix: WorldConfig[] = [
  {
    name: "dummy+enumeration",
    makeGroup: (crypto) => new DummyGroupProvider(crypto),
    makeScheme: () => new EnumerationScheme(),
  },
  {
    name: "mls+enumeration",
    makeGroup: () => new MlsGroupProvider(),
    makeScheme: () => new EnumerationScheme(),
  },
  {
    // Production MLS: OpenMLS (audited) via the vendored wasm wrapper. Same suite
    // must pass here as against dummy + ts-mls — the interchangeability proof.
    name: "openmls+enumeration",
    makeGroup: () => new OpenMlsGroupProvider(),
    makeScheme: () => new EnumerationScheme(),
  },
];
