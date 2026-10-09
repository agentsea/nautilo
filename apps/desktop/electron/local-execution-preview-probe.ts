import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RUN_SHELL_OUTPUT_ARTIFACT_PAGE_BYTES } from "./run-shell-output-continuity";

// One targeted OS ownership lookup per explicit preview click. This is a probe
// deadline, never a command/process lifetime limit.
const LOCAL_PREVIEW_PROBE_TIMEOUT_MS = 2_000;
const execute = promisify(execFile);

export function hasOwnedLoopbackListener(output: string, processGroup: number, port: number, ipv6: boolean): boolean {
  let group: number | null = null;
  let file = false;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) { group = null; file = false; }
    else if (line.startsWith("g")) group = Number(line.slice(1));
    else if (line.startsWith("f")) file = true;
    else if (line.startsWith("n") && group === processGroup && file) {
      const endpoint = line.slice(1);
      if (endpoint === `*:${port}` || endpoint === `${ipv6 ? "[::1]" : "127.0.0.1"}:${port}`) return true;
    }
  }
  return false;
}

/** Inspect only this managed process group and this exact TCP listening port. */
export async function verifyOwnedPreviewListener(processGroup: number, url: URL): Promise<boolean> {
  if (process.platform !== "darwin" || !Number.isSafeInteger(processGroup) || processGroup <= 0) return false;
  const port = url.port === "" ? 80 : Number(url.port);
  const ipv6 = url.hostname === "[::1]";
  try {
    const { stdout } = await execute("/usr/sbin/lsof", ["-nP", "-a", "-g", String(processGroup),
      `-i${ipv6 ? "6" : "4"}TCP:${port}`, "-sTCP:LISTEN", "-Fpgfn"], {
      timeout: LOCAL_PREVIEW_PROBE_TIMEOUT_MS, maxBuffer: RUN_SHELL_OUTPUT_ARTIFACT_PAGE_BYTES,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
    });
    return hasOwnedLoopbackListener(stdout, processGroup, port, ipv6);
  } catch { return false; }
}
