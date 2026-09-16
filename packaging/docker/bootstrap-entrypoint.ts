import { main as databaseBootstrap } from "../../packages/db/src/hosted-bootstrap/cli";
import { main as logtoBootstrap } from "../../bin/nautilo-local/src/hosted-logto-bootstrap";

const mode = process.env["NAUTILO_BOOTSTRAP_MODE"] ?? "database";
if (mode === "database") {
  process.exitCode = await databaseBootstrap();
} else if (mode === "logto") {
  await logtoBootstrap();
} else {
  process.stderr.write(`${JSON.stringify({ status: "failed", code: "invalid-bootstrap-mode" })}\n`);
  process.exitCode = 1;
}
