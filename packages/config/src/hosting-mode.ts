export type HostingMode = "local" | "cloud";

export function getHostingMode(env: NodeJS.ProcessEnv = process.env): HostingMode {
  const raw = env["NAUTILO_HOSTING_MODE"]?.trim().toLowerCase();
  if (raw === "cloud") return "cloud";
  if (raw === "local" || raw === undefined || raw === "") return "local";
  throw new Error(`Invalid NAUTILO_HOSTING_MODE: ${raw}. Expected "local" or "cloud".`);
}

export function isCloudMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return getHostingMode(env) === "cloud";
}
