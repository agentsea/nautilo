import { VAULT_DISK_SCHEMA_VERSION } from "./constants.ts";

export type DiskEncryptionMode = "none" | "aes_256_gcm";

export interface DiskMetadataRow {
  readonly service: string;
  readonly field: string;
  readonly category: "user";
  readonly namespace_id: string | null;
  readonly agent_id: string | null;
  readonly authored_by_user_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly expires_at: string | null;
}

export type DiskValue =
  | { readonly enc: "plain"; readonly b64: string }
  | { readonly enc: "aes_gcm"; readonly n: string; readonly b64: string };

export interface VaultDiskEnvelope {
  readonly schema_version: typeof VAULT_DISK_SCHEMA_VERSION;
  readonly config: { readonly encryption_mode: DiskEncryptionMode };
  readonly encryption?: {
    readonly sentinel?: { readonly n: string; readonly blob: string } | undefined;
  } | undefined;
  readonly metadata: Record<string, DiskMetadataRow>;
  readonly secrets: Record<string, DiskValue>;
}
