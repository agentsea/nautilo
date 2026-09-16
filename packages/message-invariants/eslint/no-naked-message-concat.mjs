// @ts-check
import { ESLintUtils } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  () =>
    "https://github.com/agentsea/nautilo/blob/main/packages/message-invariants/README.md",
);

/**
 * Detect whether `typeStr` is an array of `BaseMessage` / `ToolMessage`
 * (or *Chunk variants), allowing for arbitrarily-nested generic params
 * in the element type.
 *
 * LangChain emits deeply-nested generics — the actual shape we see in
 * practice for a `BaseMessage[]` parameter is
 * `BaseMessage<MessageStructure<MessageToolSet>, MessageType>[]`. A
 * naive regex like `<[^>]*>` (one level only) misses real hits because
 * it stops at the FIRST `>`. We walk the string with a balanced-bracket
 * scan instead.
 *
 * Deliberately narrow: only matches arrays of `BaseMessage` /
 * `ToolMessage` (and the `*Chunk` variants), NOT union types like
 * `(AIMessage | HumanMessage)[]` or `BaseMessageLike[]`. Those appear
 * in subagent/smoke code that isn't NautiloState-shaped `messages`
 * plumbing. Widening would create false positives.
 *
 * Patterns matched:
 *   - `BaseMessage[]`, `ToolMessage[]`, `BaseMessageChunk[]`, etc.
 *   - `BaseMessage<...>[]`, `ToolMessage<...>[]` with any nesting depth
 *   - `Array<BaseMessage[...]>`, `ReadonlyArray<...>`
 */
const MESSAGE_NAMES = ["BaseMessage", "ToolMessage"];

function endsWithBalancedArray(typeStr, startName) {
  // Find `startName` followed by optional balanced <...> + `Chunk`?
  // suffix + `[]`. Returns true if any such match exists.
  let from = 0;
  while (from < typeStr.length) {
    const idx = typeStr.indexOf(startName, from);
    if (idx === -1) return false;
    // Verify left-side word boundary
    if (idx > 0 && /[A-Za-z0-9_]/.test(typeStr[idx - 1])) {
      from = idx + 1;
      continue;
    }
    let i = idx + startName.length;
    // Optional `Chunk` suffix (BaseMessageChunk, ToolMessageChunk)
    if (typeStr.slice(i, i + 5) === "Chunk") i += 5;
    // Optional balanced <...>
    if (typeStr[i] === "<") {
      let depth = 1;
      i++;
      while (i < typeStr.length && depth > 0) {
        if (typeStr[i] === "<") depth++;
        else if (typeStr[i] === ">") depth--;
        i++;
      }
      if (depth !== 0) return false;
    }
    // Must end in []
    if (typeStr.slice(i, i + 2) === "[]") return true;
    from = idx + 1;
  }
  return false;
}

function isArrayWrappingMessage(typeStr) {
  // Match Array<...> or ReadonlyArray<...> with a Message name anywhere
  // in the balanced inner type.
  const m = typeStr.match(/\b(?:Array|ReadonlyArray)</);
  if (!m) return false;
  const start = m.index + m[0].length;
  let depth = 1;
  let i = start;
  while (i < typeStr.length && depth > 0) {
    if (typeStr[i] === "<") depth++;
    else if (typeStr[i] === ">") depth--;
    i++;
  }
  if (depth !== 0) return false;
  const inner = typeStr.slice(start, i - 1);
  return MESSAGE_NAMES.some((name) =>
    new RegExp(`\\b${name}\\b`).test(inner),
  );
}

function isBaseMessageArrayType(services, checker, node) {
  const tsNode = services.esTreeNodeToTSNodeMap.get(node);
  if (!tsNode) return false;
  const type = checker.getTypeAtLocation(tsNode);
  const typeStr = checker.typeToString(type);
  for (const name of MESSAGE_NAMES) {
    if (endsWithBalancedArray(typeStr, name)) return true;
  }
  return isArrayWrappingMessage(typeStr);
}

export const noNakedMessageConcat = createRule({
  name: "no-naked-message-concat",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow naked combination of BaseMessage[] arrays. Use " +
        "mergeMessagesPreservingInvariants from @nautilo/message-invariants " +
        "to preserve the tool_use ↔ tool_result invariant.",
    },
    schema: [],
    messages: {
      nakedSpread:
        "[nautilo-msg/no-naked-message-concat] Naked spread combining BaseMessage[] arrays " +
        "(e.g. [...a, ...b]) can produce duplicate tool_call_id ToolMessages. Use " +
        "mergeMessagesPreservingInvariants(a, b) from @nautilo/message-invariants. " +
        "Escape hatch: // eslint-disable-next-line nautilo-msg/no-naked-message-concat -- <reason>.",
      nakedConcat:
        "[nautilo-msg/no-naked-message-concat] Naked .concat() combining BaseMessage[] arrays " +
        "can produce duplicate tool_call_id ToolMessages. Use " +
        "mergeMessagesPreservingInvariants(a, b) from @nautilo/message-invariants. " +
        "Escape hatch: // eslint-disable-next-line nautilo-msg/no-naked-message-concat -- <reason>.",
      nakedArrayFrom:
        "[nautilo-msg/no-naked-message-concat] Array.from() over a literal that naked-spreads " +
        "BaseMessage[] arrays still collapses to the same risk. Use " +
        "mergeMessagesPreservingInvariants from @nautilo/message-invariants. " +
        "Escape hatch: // eslint-disable-next-line nautilo-msg/no-naked-message-concat -- <reason>.",
    },
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    function isBaseMessageArrayExpr(node) {
      return isBaseMessageArrayType(services, checker, node);
    }

    function arrayExprHasNakedBaseMessageSpreadPair(arr) {
      const spreads = arr.elements.filter(
        (el) => el !== null && el.type === "SpreadElement",
      );
      if (spreads.length < 2) return false;
      const baseMessageSpreads = spreads.filter((s) =>
        isBaseMessageArrayExpr(s.argument),
      );
      return baseMessageSpreads.length >= 2;
    }

    return {
      ArrayExpression(node) {
        if (arrayExprHasNakedBaseMessageSpreadPair(node)) {
          context.report({ node, messageId: "nakedSpread" });
        }
      },

      CallExpression(node) {
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.property.type === "Identifier" &&
          node.callee.property.name === "concat" &&
          isBaseMessageArrayExpr(node.callee.object) &&
          node.arguments.some((arg) => {
            const expr = arg.type === "SpreadElement" ? arg.argument : arg;
            return isBaseMessageArrayExpr(expr);
          })
        ) {
          context.report({ node, messageId: "nakedConcat" });
        }

        const isArrayFrom =
          node.callee.type === "MemberExpression" &&
          node.callee.object.type === "Identifier" &&
          node.callee.object.name === "Array" &&
          node.callee.property.type === "Identifier" &&
          node.callee.property.name === "from";

        if (isArrayFrom && node.arguments[0]?.type === "ArrayExpression") {
          const inner = node.arguments[0];
          if (arrayExprHasNakedBaseMessageSpreadPair(inner)) {
            context.report({ node, messageId: "nakedArrayFrom" });
          }
        }
      },
    };
  },
});
