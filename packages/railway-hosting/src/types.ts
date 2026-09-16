/** The public GraphQL endpoint documented by Railway. */
export const RAILWAY_GRAPHQL_ENDPOINT = "https://backboard.railway.com/graphql/v2";

/** A serializable GraphQL value. Secret values are valid only in request memory. */
export type RailwayGraphqlVariables = Readonly<Record<string, unknown>>;

/**
 * A pinned operation carries its exact operation name and document. The type
 * parameters make a caller's variables and successful data explicit without
 * pretending the full Railway schema is generated into this repository.
 */
export interface RailwayOperation<
  Name extends string,
  Variables extends RailwayGraphqlVariables,
  Data,
> {
  readonly name: Name;
  readonly document: string;
  readonly isMutation: boolean;
  readonly __variables?: Variables | undefined;
  readonly __data?: Data | undefined;
}

export type RailwayOperationVariables<Operation> =
  Operation extends RailwayOperation<string, infer Variables, unknown> ? Variables : never;

export type RailwayOperationData<Operation> =
  Operation extends RailwayOperation<string, RailwayGraphqlVariables, infer Data> ? Data : never;

/** Header values are intentionally parsed to numbers or omitted before surfacing. */
export interface RailwayRateLimitMetadata {
  readonly limit?: number | undefined;
  readonly remaining?: number | undefined;
  readonly resetAt?: string | undefined;
  readonly retryAfterMs?: number | undefined;
}

export interface RailwayResponseMetadata {
  readonly httpStatus: number;
  readonly rateLimit: RailwayRateLimitMetadata;
}

/** Do not retain or surface server error messages, extensions, or request bodies. */
export interface RailwayGraphqlErrorSummary {
  readonly kind: "graphql-error";
  readonly count: number;
}

/**
 * Narrow failure categories are evidence-based. GraphQL extension codes are
 * deliberately not classified because Railway does not document a stable set.
 */
export type RailwayFailureKind =
  | "authentication-required"
  | "permission-denied"
  | "rate-limited"
  | "graphql-error"
  | "http-failure"
  | "network-failure"
  | "invalid-response";

export interface RailwayTransportFailure {
  readonly kind: RailwayFailureKind;
  readonly operation: string;
  readonly httpStatus?: number | undefined;
  readonly retryAfterMs?: number | undefined;
  readonly graphql?: RailwayGraphqlErrorSummary | undefined;
}

/**
 * Partial data is never success. A caller must explicitly decide whether it is
 * safe to inspect it after seeing the failure instead of accidentally treating
 * a GraphQL `data` + `errors` response as a completed operation.
 */
export type RailwayTransportResult<Data> =
  | {
      readonly outcome: "success";
      readonly data: Data;
      readonly metadata: RailwayResponseMetadata;
    }
  | {
      readonly outcome: "partial";
      readonly data: Data;
      readonly failure: RailwayTransportFailure;
      readonly metadata: RailwayResponseMetadata;
    }
  | {
      readonly outcome: "failure";
      readonly failure: RailwayTransportFailure;
      readonly metadata?: RailwayResponseMetadata | undefined;
    };

/** Injectable production seam. The transport never executes the Railway CLI. */
export type RailwayFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface RailwayTransportOptions {
  /** OAuth access token, held only in process memory and never exposed by this API. */
  readonly accessToken: string;
  readonly fetch?: RailwayFetch | undefined;
  readonly endpoint?: string | undefined;
}

export interface RailwayPageInfo {
  readonly endCursor?: string | null | undefined;
  readonly hasNextPage: boolean;
}

export interface RailwayEdge<Node> {
  readonly cursor: string;
  readonly node: Node;
}

export interface RailwayConnection<Node> {
  readonly edges: readonly RailwayEdge<Node>[];
  readonly pageInfo: RailwayPageInfo;
}

export interface RailwayPaginationVariables {
  readonly first: number;
  readonly after?: string | null | undefined;
}
