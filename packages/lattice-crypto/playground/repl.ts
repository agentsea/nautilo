/**
 * Minimal poke-at-a-live-world script. Edit freely while experimenting.
 *
 *   bun run repl        (from packages/lattice-crypto)
 */
import { World } from "../src/testing/world.ts";
import { matrix } from "../src/testing/matrix.ts";

const config = matrix[0];
if (!config) throw new Error("empty matrix");

const w = new World(config);
await w.user("alice");
await w.user("bob");
const devAlice = await w.device("alice");

const ns = await w.namespace(["alice", "bob"]);
const obj = await w.encrypt(ns, "hello lattice");

const grant = await w.grantToAgent(devAlice, ["alice"]);
console.log("agent read:", await w.agentRead(obj, grant));
console.log("{alice} ⊆ {alice,bob}?", await w.engine.canAccess(["alice"], ns));
console.log("{carol} ⊆ {alice,bob}?", await w.engine.canAccess(["carol"], ns));
