import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(__dirname, "..");
const monorepoRoot = join(cliRoot, "..", "..");
const templatesSrc = join(monorepoRoot, "deploy/compose-driver/templates");
const templatesDest = join(cliRoot, "dist/deploy/compose-driver/templates");
const infraSrc = join(monorepoRoot, "infra/postgres-init.sh");
const infraDest = join(cliRoot, "dist/infra/postgres-init.sh");
const hostProbeSrc = join(monorepoRoot, "packages/config/src/host-bundle-probe.cjs");
const hostProbeDest = join(cliRoot, "dist/host-bundle-probe.cjs");

if (!existsSync(join(templatesSrc, "docker-compose.yml"))) {
  console.error(`missing compose templates at ${templatesSrc}`);
  process.exit(1);
}
if (!existsSync(infraSrc)) {
  console.error(`missing compose runtime asset at ${infraSrc}`);
  process.exit(1);
}
if (!existsSync(hostProbeSrc)) {
  console.error(`missing host port probe asset at ${hostProbeSrc}`);
  process.exit(1);
}

rmSync(templatesDest, { recursive: true, force: true });
mkdirSync(templatesDest, { recursive: true });
cpSync(templatesSrc, templatesDest, { recursive: true });

rmSync(infraDest, { force: true });
mkdirSync(dirname(infraDest), { recursive: true });
cpSync(infraSrc, infraDest);

rmSync(hostProbeDest, { force: true });
cpSync(hostProbeSrc, hostProbeDest);

console.error(`copied compose templates to ${templatesDest}`);
console.error(`copied compose runtime asset to ${infraDest}`);
console.error(`copied host port probe asset to ${hostProbeDest}`);
