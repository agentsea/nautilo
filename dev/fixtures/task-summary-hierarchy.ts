/** Cross-client Task hierarchy cases for D547 contract conformance. */
export const TASK_SUMMARY_HIERARCHY_FIXTURES = {
  root: {
    key: "root",
    prompt: "Root delegated work",
    parent: null,
    expectedDepth: 0,
  },
  nested: {
    key: "nested",
    prompt: "Nested delegated work",
    parent: "root",
    expectedDepth: 1,
  },
  orphanedLineage: {
    key: "orphaned-lineage",
    prompt: "Delegated work whose parent was deleted",
    parent: null,
    expectedDepth: 1,
  },
} as const;
