import { ToolCatalog } from "@nautilo/catalog";
import { buildToolCatalogMatrix } from "../src/tools/catalog-matrix";
import { registerAllTools } from "../src/tools/register-all";

const catalog = new ToolCatalog();
registerAllTools(catalog, { officeCliAvailable: () => false });
process.stdout.write(`${JSON.stringify(buildToolCatalogMatrix(catalog.query({})), null, 2)}\n`);
