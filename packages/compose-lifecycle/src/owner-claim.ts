import { createHash } from "node:crypto";

export interface ComposeOwnerClaimIdentity {
  readonly profileName: string;
  readonly instanceId: string;
  readonly controlFingerprint: string;
  readonly mode: "claim" | "owner-config";
  readonly seedResultPath?: string;
}

/** Safe, persistable checkpoint. It deliberately contains no claim secret. */
export interface PreparedComposeOwnerStage {
  readonly schemaVersion: 1;
  readonly identity: ComposeOwnerClaimIdentity;
}

export interface ComposeOwnerClaimCustodyPort {
  getOrCreate(identity: ComposeOwnerClaimIdentity): Promise<string>;
  rotate(identity: ComposeOwnerClaimIdentity): Promise<string>;
  clear(identity: ComposeOwnerClaimIdentity): Promise<void>;
}

export interface ComposeOwnerClaimControlPort {
  observe(): Promise<{ readonly state: "awaiting-owner" | "claim-active" | "owner-bound" }>;
  /** Resolve authority after observation but before mutation; failures are not reconciled as writes. */
  prepareInstall?(): Promise<void>;
  install(input: {
    readonly claimHash: string;
    readonly expiresAt: string;
  }): Promise<{
    readonly state: "awaiting-owner" | "claim-active" | "owner-bound" | "unknown";
  }>;
  classifyFailure?(error: unknown): string | undefined;
}

export interface ComposeOwnerClaimStageResult {
  readonly outcome:
    | "owner-bound"
    | "claim-active"
    | "awaiting-owner"
    | "install-unknown"
    | "target-unavailable";
  readonly controllerFailure?: string;
}

const CLAIM_TTL_MS = 14 * 60_000;

export async function prepareComposeOwnerStage(input: {
  readonly identity: ComposeOwnerClaimIdentity;
  readonly custody: ComposeOwnerClaimCustodyPort;
}): Promise<PreparedComposeOwnerStage> {
  await input.custody.getOrCreate(input.identity);
  return { schemaVersion: 1, identity: input.identity };
}

export async function observeComposeOwnerStage(input: {
  readonly identity: ComposeOwnerClaimIdentity;
  readonly custody: ComposeOwnerClaimCustodyPort;
  readonly control: ComposeOwnerClaimControlPort;
}): Promise<ComposeOwnerClaimStageResult> {
  try {
    const observed = await input.control.observe();
    if (observed.state === "owner-bound") {
      await input.custody.clear(input.identity);
      return { outcome: "owner-bound" };
    }
    return { outcome: observed.state };
  } catch (error) {
    const failure = input.control.classifyFailure?.(error);
    return {
      outcome: "target-unavailable",
      ...(failure === undefined ? {} : { controllerFailure: failure }),
    };
  }
}

/** One bounded mutation/reconciliation step. It never polls, opens a browser, or writes output. */
export async function advanceComposeOwnerStage(input: {
  readonly stage: PreparedComposeOwnerStage;
  readonly resume: boolean;
  readonly custody: ComposeOwnerClaimCustodyPort;
  readonly control: ComposeOwnerClaimControlPort;
  readonly now?: () => number;
}): Promise<ComposeOwnerClaimStageResult> {
  let observed;
  try {
    observed = await input.control.observe();
  } catch (error) {
    const failure = input.control.classifyFailure?.(error);
    return {
      outcome: "target-unavailable",
      ...(failure === undefined ? {} : { controllerFailure: failure }),
    };
  }
  if (observed.state === "owner-bound") {
    await input.custody.clear(input.stage.identity);
    return { outcome: "owner-bound" };
  }

  const claim = observed.state === "awaiting-owner" && input.resume
    ? await input.custody.rotate(input.stage.identity)
    : await input.custody.getOrCreate(input.stage.identity);
  await input.control.prepareInstall?.();
  const request = {
    claimHash: createHash("sha256").update(claim, "utf8").digest("hex"),
    expiresAt: new Date((input.now ?? Date.now)() + CLAIM_TTL_MS).toISOString(),
  };
  const install = async (): Promise<ComposeOwnerClaimStageResult> => {
    const result = await input.control.install(request);
    if (result.state === "owner-bound") {
      await input.custody.clear(input.stage.identity);
      return { outcome: "owner-bound" };
    }
    return { outcome: result.state === "claim-active" ? "claim-active" : "install-unknown" };
  };
  try {
    return await install();
  } catch (error) {
    try {
      const afterWrite = await input.control.observe();
      if (afterWrite.state === "owner-bound") {
        await input.custody.clear(input.stage.identity);
        return { outcome: "owner-bound" };
      }
      if (afterWrite.state !== "claim-active") {
        const failure = input.control.classifyFailure?.(error);
        return {
          outcome: "install-unknown",
          ...(failure === undefined ? {} : { controllerFailure: failure }),
        };
      }
      return await install();
    } catch {
      const failure = input.control.classifyFailure?.(error);
      return {
        outcome: "install-unknown",
        ...(failure === undefined ? {} : { controllerFailure: failure }),
      };
    }
  }
}
