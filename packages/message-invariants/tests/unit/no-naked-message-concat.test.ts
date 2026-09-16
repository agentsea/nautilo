// CI-pin for the `nautilo-msg/no-naked-message-concat` ESLint rule.
//
// Context: D143 Phase 3 shipped the rule (eslint/no-naked-message-concat.mjs)
// but did NOT include a @typescript-eslint/rule-tester suite. The rule's
// behavior — including the balanced-bracket nested-generic scanner that fixed
// the original D143 regression — was therefore unprotected from refactor /
// mutation regressions. ISSUE-D148 (Stack 22) backfills that suite.
//
// This file exercises the rule end-to-end via the type-aware RuleTester,
// covering all three messageIds (`nakedSpread`, `nakedConcat`, `nakedArrayFrom`)
// plus the early-exit and "non-message array" valid paths. Cases mirror the
// ISSUE-D148 spec 1:1; case names (V1..V6, IS1..IS4, IC1..IC2, IA1) are kept
// in the `name` field for grep-ability when triaging mutation-test output.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { RuleTester } from "@typescript-eslint/rule-tester";
import type { TSESLint } from "@typescript-eslint/utils";
import { afterAll, describe, test } from "bun:test";

// The rule body is authored as JS with JSDoc (`eslint/no-naked-message-concat.mjs`)
// and ships no .d.mts sidecar, so TypeScript resolves the import to `any` under
// `noImplicitAny`. We re-type it here at the import boundary so both the
// typechecker and `@typescript-eslint/no-unsafe-argument` are satisfied
// without needing to edit the rule body itself.
// @ts-expect-error -- rule body is JS+JSDoc; no .d.mts shipped
import { noNakedMessageConcat as noNakedMessageConcatUntyped } from "../../eslint/no-naked-message-concat.mjs";

const noNakedMessageConcat = noNakedMessageConcatUntyped as TSESLint.RuleModule<
  "nakedSpread" | "nakedConcat" | "nakedArrayFrom",
  []
>;

// Bridge @typescript-eslint/rule-tester onto bun:test (it expects mocha-style
// globals; bun:test exposes equivalents).
RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = test;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// packages/message-invariants/ — i.e. up two from tests/unit/
const packageRoot = path.resolve(__dirname, "../..");

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: {
      projectService: {
        allowDefaultProject: ["*.ts*"],
        defaultProject: "./tsconfig.json",
      },
      tsconfigRootDir: packageRoot,
    },
  },
});

const MESSAGE_IMPORT = `import { BaseMessage, ToolMessage } from "@langchain/core/messages";\n`;

ruleTester.run("no-naked-message-concat", noNakedMessageConcat, {
  valid: [
    {
      name: "V1: canonical mergeMessagesPreservingInvariants(a, b) call",
      code:
        MESSAGE_IMPORT +
        `import { mergeMessagesPreservingInvariants } from "../../src/index.js";
function f(a: BaseMessage[], b: BaseMessage[]) {
  return mergeMessagesPreservingInvariants(a, b);
}
`,
    },
    {
      name: "V2: spread of two string[] arrays does not fire",
      code: `function f(a: string[], b: string[]) {
  return [...a, ...b];
}
`,
    },
    {
      name: "V3: spread of two Record<string, unknown>[] arrays does not fire",
      code: `function f(a: Record<string, unknown>[], b: Record<string, unknown>[]) {
  return [...a, ...b];
}
`,
    },
    {
      name: "V4: single-spread of BaseMessage[] does not fire (spreads.length < 2)",
      code:
        MESSAGE_IMPORT +
        `function f(a: BaseMessage[]) {
  return [...a];
}
`,
    },
    {
      name: "V5: BaseMessage[].concat with a non-message argument does not fire",
      code:
        MESSAGE_IMPORT +
        `function f(a: BaseMessage[]) {
  return a.concat(["just-a-string"]);
}
`,
    },
    {
      // NOTE: production code uses the plugin-prefixed form
      // `// eslint-disable-next-line nautilo-msg/no-naked-message-concat`,
      // but @typescript-eslint/rule-tester registers the rule under its own
      // internal `@rule-tester/...` prefix, so the production prefix would not
      // match here. The bare `eslint-disable-next-line` directive disables all
      // rules on the next line and is a valid ESLint escape-hatch shape; that
      // is what we pin here. End-to-end coverage of the prefixed form lives
      // implicitly in the production lint config.
      name: "V6: bare eslint-disable-next-line escape hatch silences the rule",
      code:
        MESSAGE_IMPORT +
        `function f(a: BaseMessage[], b: BaseMessage[]) {
  // eslint-disable-next-line -- escape hatch test
  return [...a, ...b];
}
`,
    },
    {
      // Pins the DELIBERATE narrowness of MESSAGE_NAMES at
      // no-naked-message-concat.mjs:32 (only BaseMessage / ToolMessage match).
      // Per the rule body's docstring at mjs:22-25, subtype unions like
      // (AIMessage | HumanMessage)[] appear in subagent / smoke code that
      // isn't NautiloState-shaped `messages` plumbing — widening would
      // create false positives. This case locks that decision in: a future
      // refactor that adds AIMessage / HumanMessage / SystemMessage to
      // MESSAGE_NAMES "to be safe" will break this test, forcing the writer
      // to re-read the docstring and make the call deliberately.
      name: "V7: AIMessage[] + HumanMessage[] spread (subtype-narrowness pin)",
      code: `import { AIMessage, HumanMessage } from "@langchain/core/messages";
function f(a: AIMessage[], b: HumanMessage[]) {
  return [...a, ...b];
}
`,
    },
  ],
  invalid: [
    {
      name: "IS1: naked spread of two BaseMessage[] arrays",
      code:
        MESSAGE_IMPORT +
        `function f(a: BaseMessage[], b: BaseMessage[]) {
  return [...a, ...b];
}
`,
      errors: [{ messageId: "nakedSpread" }],
    },
    {
      name: "IS2: naked spread mixing BaseMessage[] and ToolMessage[]",
      code:
        MESSAGE_IMPORT +
        `function f(a: BaseMessage[], b: ToolMessage[]) {
  return [...a, ...b];
}
`,
      errors: [{ messageId: "nakedSpread" }],
    },
    {
      name: "IS3: naked spread of nested-generic BaseMessage<MS, MT>[] (D143 regression shape)",
      code:
        `import { BaseMessage, type MessageStructure } from "@langchain/core/messages";
type MS = MessageStructure;
type MT = "ai";
function f(a: BaseMessage<MS, MT>[], b: BaseMessage<MS, MT>[]) {
  return [...a, ...b];
}
`,
      errors: [{ messageId: "nakedSpread" }],
    },
    {
      // NOTE on dead-branch finding: this case was originally added to
      // exercise `isArrayWrappingMessage` at no-naked-message-concat.mjs:67-85
      // (the `Array<T>` / `ReadonlyArray<T>` predicate). The D148 mutation
      // proof revealed that TypeScript's `checker.typeToString()` normalizes
      // `Array<BaseMessage>` to `BaseMessage[]` BEFORE the predicate sees it,
      // so this case is actually caught by `endsWithBalancedArray` (the `T[]`
      // predicate at mjs:34-65), NOT by `isArrayWrappingMessage`. The latter
      // is empirically a no-op for every shape exercised here; the focused
      // audit (D167) should determine whether any input shape keeps
      // `Array<T>` un-normalized in `typeToString`. If not, the
      // `isArrayWrappingMessage` branch is dead code and can be deleted.
      // Until D167 lands the branch stays as defense-in-depth.
      name: "IS4: naked spread of Array<BaseMessage> and ReadonlyArray<BaseMessage>",
      code:
        MESSAGE_IMPORT +
        `function f(a: Array<BaseMessage>, b: ReadonlyArray<BaseMessage>) {
  return [...a, ...b];
}
`,
      errors: [{ messageId: "nakedSpread" }],
    },
    {
      name: "IC1: naked a.concat(b) on BaseMessage[]",
      code:
        MESSAGE_IMPORT +
        `function f(a: BaseMessage[], b: BaseMessage[]) {
  return a.concat(b);
}
`,
      errors: [{ messageId: "nakedConcat" }],
    },
    {
      name: "IC2: naked .concat(...[b, c]) spread-in-arg shape",
      code:
        MESSAGE_IMPORT +
        `function f(a: BaseMessage[], b: BaseMessage[], c: BaseMessage[]) {
  return a.concat(...[b, c]);
}
`,
      errors: [{ messageId: "nakedConcat" }],
    },
    {
      // NOTE: this case fires BOTH `nakedArrayFrom` (on the Array.from call)
      // AND `nakedSpread` (on the inner [...a, ...b] literal). The two
      // visitors are independent in the rule body — the ArrayExpression visit
      // does not check whether its parent is an Array.from call. Pinning both
      // messages so that any refactor that silently drops one of them gets
      // caught. CallExpression entry fires first (parent before child on
      // ESLint walk), hence the order below.
      name: "IA1: Array.from() over a literal that naked-spreads BaseMessage[]",
      code:
        MESSAGE_IMPORT +
        `function f(a: BaseMessage[], b: BaseMessage[]) {
  return Array.from([...a, ...b]);
}
`,
      errors: [
        { messageId: "nakedArrayFrom" },
        { messageId: "nakedSpread" },
      ],
    },
    {
      // Pins the Chunk-suffix branch at no-naked-message-concat.mjs:48.
      // The balanced-bracket scanner explicitly accepts BaseMessageChunk /
      // ToolMessageChunk as message-array element types because LangChain's
      // streaming code paths surface chunks in the same `messages` plumbing
      // that the non-streaming code surfaces full messages. A refactor that
      // drops the `Chunk` suffix handling would silently disable L2 defense
      // for any streaming-mode code path.
      name: "IS5: naked spread of BaseMessageChunk[] arrays (streaming variant)",
      code: `import { BaseMessageChunk } from "@langchain/core/messages";
function f(a: BaseMessageChunk[], b: BaseMessageChunk[]) {
  return [...a, ...b];
}
`,
      errors: [{ messageId: "nakedSpread" }],
    },
    {
      // Mixed base + Chunk variant; both must be recognized for the rule
      // to flag the spread pair. Pins the case where streaming + non-
      // streaming paths get accidentally merged.
      name: "IS6: naked spread mixing BaseMessage[] and ToolMessageChunk[]",
      code: `import { BaseMessage, ToolMessageChunk } from "@langchain/core/messages";
function f(a: BaseMessage[], b: ToolMessageChunk[]) {
  return [...a, ...b];
}
`,
      errors: [{ messageId: "nakedSpread" }],
    },
  ],
});
