export const CLOUD_MANAGED_PROVIDER_KEYS = [
  "OPENROUTER_API_KEY",
  "ELEVENLABS_API_KEY",
  "TAVILY_API_KEY",
  "CLOUDCONVERT_API_KEY",
  "VENICE_API_KEY",
] as const;

export function isCloudManagedProviderKey(key: string): boolean {
  return (CLOUD_MANAGED_PROVIDER_KEYS as readonly string[]).includes(key);
}

export function isCloudManagedDeployment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["NAUTILO_DEPLOYMENT_MODE"]?.trim() === "cloud-managed";
}
