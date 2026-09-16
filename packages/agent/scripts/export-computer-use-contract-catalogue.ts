import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { bundledComputerUseContractCatalogue } from "../src/config/computer-use-catalogue/catalog.js";

const [outputArgument, ...argumentsList] = process.argv.slice(2);
const output = outputArgument?.trim();
if (!output) {
  throw new Error("usage: bun run computer-use-catalogue:export -- <output.json> [--catalogue-version VERSION --published-at ISO8601]");
}

const { provenance: _provenance, ...snapshot } = bundledComputerUseContractCatalogue;
for (let index = 0; index < argumentsList.length; index += 2) {
  const flag = argumentsList[index];
  const value = argumentsList[index + 1]?.trim();
  if (!value || (flag !== "--catalogue-version" && flag !== "--published-at")) {
    throw new Error("computer use catalogue export arguments rejected");
  }
  if (flag === "--catalogue-version") snapshot.catalogueVersion = value;
  else snapshot.publishedAt = value;
}
await writeFile(resolve(output), `${JSON.stringify(snapshot, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o644,
});
