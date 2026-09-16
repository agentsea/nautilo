export type ProtectedMemorySearchPlan =
  | Readonly<{ readonly kind: "semantic" }>
  | Readonly<{
    readonly kind: "unavailable";
    readonly code: "plaintext_text_search_unavailable";
  }>;

export function planProtectedMemorySearch(
  mode: "text" | "vector",
): ProtectedMemorySearchPlan {
  return mode === "vector"
    ? { kind: "semantic" }
    : {
        kind: "unavailable",
        code: "plaintext_text_search_unavailable",
      };
}
