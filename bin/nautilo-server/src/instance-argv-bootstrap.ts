import { applyInstanceArgFromArgv } from "@nautilo/config";

try {
  applyInstanceArgFromArgv(process.argv, process.env);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(msg);
  process.exit(2);
}
