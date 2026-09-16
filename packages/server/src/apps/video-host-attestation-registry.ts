import { randomBytes } from "node:crypto";

export const VIDEO_HOST_ATTESTATION_TTL_MS = 5 * 60_000;

export interface VideoHostAttestationBinding {
  readonly userId: string;
  readonly sourceHash: string;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly projectArtifactInternalId: string;
  readonly projectArtifactId: string;
  readonly projectRevision: number;
}

type Entry = Readonly<{ binding: VideoHostAttestationBinding; expiresAt: number }>;

/** Separate parent-only 256-bit capability; never a live-review session token. */
export class VideoHostAttestationRegistry {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly now: () => number = Date.now) {}

  private prune(): void {
    const now = this.now();
    for (const [token, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(token);
  }

  issue(binding: VideoHostAttestationBinding): { token: string; expiresAt: string } {
    this.prune();
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + VIDEO_HOST_ATTESTATION_TTL_MS;
    this.entries.set(token, { binding: Object.freeze({ ...binding }), expiresAt });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  validate(token: string, expected: VideoHostAttestationBinding): boolean {
    this.prune();
    const entry = this.entries.get(token);
    if (!entry || entry.expiresAt <= this.now()) return false;
    return Object.entries(expected).every(([key, value]) =>
      entry.binding[key as keyof VideoHostAttestationBinding] === value);
  }

  validateForProject(
    token: string,
    expected: Omit<VideoHostAttestationBinding, "sourceHash">,
  ): VideoHostAttestationBinding | null {
    this.prune();
    const entry = this.entries.get(token);
    if (!entry || entry.expiresAt <= this.now()) return null;
    return Object.entries(expected).every(([key, value]) =>
      entry.binding[key as keyof VideoHostAttestationBinding] === value)
      ? entry.binding
      : null;
  }

  revokeForUser(token: string, userId: string): boolean {
    const entry = this.entries.get(token);
    if (!entry || entry.binding.userId !== userId) return false;
    this.entries.delete(token);
    return true;
  }
  clear(): void { this.entries.clear(); }
}

export const videoHostAttestationRegistry = new VideoHostAttestationRegistry();
