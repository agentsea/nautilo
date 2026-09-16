import { describe, expect, test } from "bun:test";

import { paginateRailwayConnection, type RailwayPageRequest } from "../../src/index";

describe("paginateRailwayConnection", () => {
  test("follows Railway edges/pageInfo cursors in order", async () => {
    const seenCursors: Array<string | null | undefined> = [];
    const request: RailwayPageRequest<{ readonly first: number; readonly after?: string | null }, string> = {
      initialVariables: { first: 2 },
      fetchPage: async (variables) => {
        seenCursors.push(variables.after);
        if (variables.after === undefined) {
          return {
            outcome: "success",
            data: {
              edges: [
                { cursor: "cursor-1", node: "one" },
                { cursor: "cursor-2", node: "two" },
              ],
              pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
            },
            metadata: { httpStatus: 200, rateLimit: {} },
          };
        }
        return {
          outcome: "success",
          data: {
            edges: [{ cursor: "cursor-3", node: "three" }],
            pageInfo: { hasNextPage: false, endCursor: "cursor-3" },
          },
          metadata: { httpStatus: 200, rateLimit: {} },
        };
      },
    };

    const result = await paginateRailwayConnection(request);
    expect(result).toEqual({
      outcome: "success",
      nodes: ["one", "two", "three"],
    });
    expect(seenCursors).toEqual([undefined, "cursor-2"]);
  });

  test("fails closed if Railway says another page exists without an end cursor", async () => {
    const request: RailwayPageRequest<{ readonly first: number; readonly after?: string | null }, string> = {
      initialVariables: { first: 1 },
      fetchPage: async () => ({
        outcome: "success",
        data: {
          edges: [{ cursor: "cursor-1", node: "one" }],
          pageInfo: { hasNextPage: true, endCursor: null },
        },
        metadata: { httpStatus: 200, rateLimit: {} },
      }),
    };

    const result = await paginateRailwayConnection(request);
    expect(result).toEqual({
      outcome: "incomplete",
      nodes: ["one"],
      result: {
        outcome: "failure",
        failure: { kind: "invalid-response", operation: "RailwayPagination" },
      },
    });
  });

  test("fails closed if a later page repeats a cursor", async () => {
    let calls = 0;
    const request: RailwayPageRequest<{ readonly first: number; readonly after?: string | null }, string> = {
      initialVariables: { first: 1 },
      fetchPage: async () => {
        calls += 1;
        return {
          outcome: "success",
          data: {
            edges: [{ cursor: "cursor-1", node: `node-${calls}` }],
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          },
          metadata: { httpStatus: 200, rateLimit: {} },
        };
      },
    };

    const result = await paginateRailwayConnection(request);
    expect(result).toEqual({
      outcome: "incomplete",
      nodes: ["node-1", "node-2"],
      result: {
        outcome: "failure",
        failure: { kind: "invalid-response", operation: "RailwayPagination" },
      },
    });
    expect(calls).toBe(2);
  });
});
