import type {
  RailwayConnection,
  RailwayPaginationVariables,
  RailwayTransportResult,
} from "./types";

export interface RailwayPageRequest<Variables extends RailwayPaginationVariables, Node> {
  readonly fetchPage: (variables: Variables) => Promise<RailwayTransportResult<RailwayConnection<Node>>>;
  readonly initialVariables: Variables;
}

export type RailwayPaginateResult<Node> =
  | { readonly outcome: "success"; readonly nodes: readonly Node[] }
  | { readonly outcome: "incomplete"; readonly nodes: readonly Node[]; readonly result: Exclude<RailwayTransportResult<RailwayConnection<Node>>, { readonly outcome: "success" }> };

/**
 * Cursor iteration follows Railway's documented `edges` + `pageInfo` shape.
 * A malformed next-page cursor fails closed rather than looping or dropping it.
 */
export async function paginateRailwayConnection<Variables extends RailwayPaginationVariables, Node>(
  request: RailwayPageRequest<Variables, Node>,
): Promise<RailwayPaginateResult<Node>> {
  const nodes: Node[] = [];
  let variables = request.initialVariables;
  const seenCursors = new Set<string>();
  if (variables.after !== null && variables.after !== undefined && variables.after !== "") {
    seenCursors.add(variables.after);
  }

  for (;;) {
    const result = await request.fetchPage(variables);
    if (result.outcome !== "success") {
      return { outcome: "incomplete", nodes, result };
    }

    const { edges, pageInfo } = result.data;
    nodes.push(...edges.map((edge) => edge.node));
    if (!pageInfo.hasNextPage) {
      return { outcome: "success", nodes };
    }
    if (
      pageInfo.endCursor === null ||
      pageInfo.endCursor === undefined ||
      pageInfo.endCursor === "" ||
      seenCursors.has(pageInfo.endCursor)
    ) {
      return {
        outcome: "incomplete",
        nodes,
        result: {
          outcome: "failure",
          failure: { kind: "invalid-response", operation: "RailwayPagination" },
        },
      };
    }
    seenCursors.add(pageInfo.endCursor);
    variables = { ...variables, after: pageInfo.endCursor };
  }
}
