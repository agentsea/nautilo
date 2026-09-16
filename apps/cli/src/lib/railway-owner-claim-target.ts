import {
  createOwnerClaimTarget, hashOwnerClaim, OwnerClaimControllerError,
  type OwnerClaimControllerFailure, type OwnerClaimState, type OwnerClaimTargetStatus,
} from "./owner-claim-target.ts";

export type RailwayOwnerClaimControllerErrorCode =
  | "railway.owner-claim.unreachable" | "railway.owner-claim.timeout" | "railway.owner-claim.authorization-rejected"
  | "railway.owner-claim.contract-rejected" | "railway.owner-claim.invalid-response" | "railway.owner-claim.ambiguous-write";
export class RailwayOwnerClaimControllerError extends Error {
  readonly code: RailwayOwnerClaimControllerErrorCode;
  constructor(code: RailwayOwnerClaimControllerErrorCode) {
    super(code); this.name = "RailwayOwnerClaimControllerError"; this.code = code;
  }
}
export type RailwayOwnerClaimState = OwnerClaimState;
export type RailwayOwnerClaimTargetStatus = Omit<OwnerClaimTargetStatus, "state"> & {
  readonly state: RailwayOwnerClaimState;
};
export interface RailwayOwnerClaimTarget {
  status(input: { readonly targetUrl: string }): Promise<RailwayOwnerClaimTargetStatus>;
  install(input: {
    readonly targetUrl: string;
    readonly bootstrapToken: string;
    readonly claimHash: string;
    readonly expiresAt: string;
  }): Promise<RailwayOwnerClaimTargetStatus>;
}

function railwayTargetUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") throw new Error("Railway owner target is invalid");
  return url;
}
function railwayFailure(failure: OwnerClaimControllerFailure): RailwayOwnerClaimControllerErrorCode {
  switch (failure) {
    case "unreachable": return "railway.owner-claim.unreachable";
    case "timeout": return "railway.owner-claim.timeout";
    case "authorization-rejected": return "railway.owner-claim.authorization-rejected";
    case "contract-rejected": return "railway.owner-claim.contract-rejected";
    case "invalid-response": return "railway.owner-claim.invalid-response";
    case "ambiguous-write": return "railway.owner-claim.ambiguous-write";
  }
}
function rethrowRailway(error: unknown): never {
  if (error instanceof OwnerClaimControllerError) throw new RailwayOwnerClaimControllerError(railwayFailure(error.failure));
  throw error;
}
export function hashRailwayOwnerClaim(claim: string): string {
  if (!/^inv_[A-Za-z0-9_-]{32}$/.test(claim)) throw new Error("Railway owner claim is invalid");
  return hashOwnerClaim(claim);
}
export function createRailwayOwnerClaimTarget(fetchImpl: typeof fetch = fetch): RailwayOwnerClaimTarget {
  const target = createOwnerClaimTarget({ fetchImpl, transport: { validateTargetUrl: railwayTargetUrl, timeoutMs: 10_000 } });
  return {
    async status(input) {
      try { return await target.status(input); } catch (error) { return rethrowRailway(error); }
    },
    async install(input) {
      const expiresAt = new Date(input.expiresAt);
      if (!/^[a-f0-9]{64}$/.test(input.claimHash) || !Number.isFinite(expiresAt.valueOf())
        || expiresAt.toISOString() !== input.expiresAt || input.bootstrapToken.length < 32) throw new Error("Railway owner claim installation is invalid");
      try {
        return await target.install({
          targetUrl: input.targetUrl,
          authorization: { kind: "bearer", token: input.bootstrapToken },
          claimHash: input.claimHash,
          expiresAt: input.expiresAt,
        });
      } catch (error) { return rethrowRailway(error); }
    },
  };
}
