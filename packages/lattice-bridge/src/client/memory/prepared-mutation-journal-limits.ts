/**
 * One shared durability budget for the platform-neutral journal and every
 * concrete sealed-storage adapter. Ordinary prepared mutations remain capped
 * at 4 MiB. One temporary additional-device campaign may use the existing
 * 96 MiB route bound, still outside the smaller device-profile document.
 */
export const PREPARED_MUTATION_JOURNAL_LIMITS = Object.freeze({
  maxRecords: 64,
  warningRecords: 48,
  maxTotalSealedBytes: 132 * 1_048_576,
  warningTotalSealedBytes: 24 * 1_048_576,
  maxCanonicalRecordBytes: 4 * 1_048_576,
  maxAdditionalDeviceCampaignBytes: 96 * 1_048_576,
  maxAttempts: 12,
  maxBatch: 4,
  maxAttemptsPerMinute: 16,
  attemptRateWindowMs: 60_000,
  retryBaseMs: 5_000,
  retryMaxMs: 60 * 60_000,
  retentionMs: 30 * 24 * 60 * 60_000,
} as const);
