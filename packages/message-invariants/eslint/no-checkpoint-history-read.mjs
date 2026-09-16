// @ts-check
import { ESLintUtils } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  () =>
    "https://github.com/agentsea/nautilo-public/blob/main/packages/message-invariants/README.md",
);

/**
 * ISSUE-M171 (Phase H) — forbid reading the LangGraph **checkpoint** as a
 * source of conversation HISTORY.
 *
 * After M168–M171 the DB transcript (`session_messages`) is the single source
 * of truth for history; the checkpoint is reduced to ephemeral in-flight
 * execution state for ONE turn (approvals / `prove_it` / `await_human_reply`
 * resume + subagent output extraction). This rule flags the exact shape a
 * history-rebuild read takes — the `messages` member of the `.values` of a
 * `getState(...)` result — so no one re-introduces a checkpoint-history read.
 *
 * Matching shape (per ISSUE-M171 R7 — match the REAL shape the codebase uses):
 * every live read is optional-chained + computed bracket, e.g.
 * `state?.values?.["messages"]`. A dot-only matcher would silently pass the
 * very reads it must catch, so the matcher MUST handle:
 *   - `.values.messages`            (plain dotted)
 *   - `.values["messages"]`         (computed bracket)
 *   - `?.values?.messages`          (optional dotted)
 *   - `?.values?.["messages"]`      (optional computed — the live shape)
 *
 * In current ESTree / `@typescript-eslint`, optional chaining is represented as
 * a `MemberExpression` with `optional: true` (wrapped in a `ChainExpression`),
 * NOT a distinct `OptionalMemberExpression` node — so listening on
 * `MemberExpression` and inspecting `computed` + `optional` covers all four
 * forms. (A defensive `OptionalMemberExpression` listener is also registered in
 * case a Babel-style parser is ever used.)
 *
 * Allowlist (R8): the legitimate remaining `.values.messages` reads —
 * subagent/await-reply OUTPUT EXTRACTION + resume-outcome inspection — are
 * permitted by EXCLUDING those files via `ignores` in `eslint.config.mjs`
 * (mirrors the `m125` / `d168` file-glob allowlist pattern), NOT by an
 * in-rule allowlist.
 */

/**
 * Resolve the statically-known property name of a member access node,
 * regardless of dotted vs computed-bracket access. Returns null for dynamic
 * (non-literal computed) properties.
 *
 * @param {any} node
 * @returns {string | null}
 */
function staticMemberPropertyName(node) {
  if (
    !node ||
    (node.type !== "MemberExpression" && node.type !== "OptionalMemberExpression")
  ) {
    return null;
  }
  const prop = node.property;
  if (!prop) return null;
  if (!node.computed && prop.type === "Identifier") return prop.name;
  if (
    node.computed &&
    prop.type === "Literal" &&
    typeof prop.value === "string"
  ) {
    return prop.value;
  }
  return null;
}

/** @param {any} node */
function isValuesMember(node) {
  return (
    !!node &&
    (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") &&
    staticMemberPropertyName(node) === "values"
  );
}

export const noCheckpointHistoryRead = createRule({
  name: "no-checkpoint-history-read",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow reading the `messages` member off the `.values` of a " +
        "getState(...) result (a checkpoint-history read). History comes from " +
        "the DB transcript after ISSUE-M171; the checkpoint is in-flight " +
        "execution state only.",
    },
    schema: [],
    messages: {
      checkpointHistoryRead:
        "[nautilo-msg/no-checkpoint-history-read] Reading `.values.messages` off a " +
        "graph state (the checkpoint) as conversation HISTORY is forbidden after ISSUE-M171 " +
        "(Phase H). The DB transcript (`session_messages`) is the single source of truth for " +
        "history — rebuild via `buildTranscriptContext` / `resolveForegroundHistoryMessages`. " +
        "The checkpoint is still WRITTEN (in-flight execution state) and may be read for " +
        "mid-turn resume / subagent output extraction ONLY (those files are allowlisted in " +
        "eslint.config.mjs). See ISSUE-M171.",
    },
  },
  defaultOptions: [],
  create(context) {
    /** @param {any} node */
    function check(node) {
      if (staticMemberPropertyName(node) !== "messages") return;
      if (isValuesMember(node.object)) {
        context.report({ node, messageId: "checkpointHistoryRead" });
      }
    }
    return {
      MemberExpression: check,
      // Defensive: Babel-style parsers emit a distinct node type. No-op under
      // espree / @typescript-eslint (which never produce it).
      OptionalMemberExpression: check,
    };
  },
});
