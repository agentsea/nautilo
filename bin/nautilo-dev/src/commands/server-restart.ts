/**
 * M100/M097 follow-up — `server:restart` is just `server:stop` followed by
 * `server:start`, with the output framed so the operator sees both phases.
 */
import { serverStart } from "./server-start";
import { serverStop } from "./server-stop";

export interface ServerRestartOptions {
  requireWorkbenchDist?: boolean;
}

export async function serverRestart(options: ServerRestartOptions = {}): Promise<number> {
  console.log("[server:restart] stopping…");
  const stopCode = await serverStop();
  if (stopCode !== 0) {
    console.warn(
      "[server:restart] stop returned non-zero; refusing to start a new instance on top of an unknown listener",
    );
    return stopCode;
  }
  console.log("[server:restart] starting…");
  return serverStart({
    ...(options.requireWorkbenchDist !== undefined
      ? { requireWorkbenchDist: options.requireWorkbenchDist }
      : {}),
  });
}
