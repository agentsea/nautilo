import { parseDotenv } from "@nautilo/db";

/** Freeze only public infrastructure selections, never credentials, in a backup. */
export function pinRecoveryComposeTemplate(template: string, composeEnv: string): string {
  const values = parseDotenv(composeEnv);
  return template.replace(/\$\{(LOGTO_IMAGE|LOGTO_IMAGE_TAG|POSTGRES_IMAGE|PGVECTOR_IMAGE)(?::[-?][^}\r\n]*)?\}/g, (_token: string, key: string) => {
    const value = values[key];
    const valid = key === "LOGTO_IMAGE_TAG"
      ? /^\d+\.\d+\.\d+$/.test(value ?? "")
      : /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(value ?? "");
    if (!valid) throw new Error(`backup: missing or invalid immutable recovery selection ${key}`);
    return value!;
  });
}
