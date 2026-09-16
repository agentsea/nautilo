import { applyInstanceArgFromArgv } from "@nautilo/config";
import { initDesktopAuthProfileFromArgv } from "./auth/token-store-electron";

try {
  applyInstanceArgFromArgv(process.argv, process.env);
  initDesktopAuthProfileFromArgv(process.argv);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(msg);
  process.exit(2);
}
