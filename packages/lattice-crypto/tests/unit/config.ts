import { DummyGroupProvider } from "../../src/group/dummy.ts";
import { EnumerationScheme } from "../../src/lattice/enumeration.ts";
import type { WorldConfig } from "../../src/testing/world.ts";

/**
 * The unit lane is deliberately binary-free. It uses only deterministic
 * in-memory collaborators and must never import the full provider matrix.
 */
export const unitWorldConfig: WorldConfig = {
  name: "unit-dummy+enumeration",
  makeGroup: (crypto) => new DummyGroupProvider(crypto),
  makeScheme: () => new EnumerationScheme(),
};
