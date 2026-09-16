// CI-pin for the `nautilo-msg/no-checkpoint-history-read` ESLint rule
// (ISSUE-M171 Phase H).
//
// The rule forbids reading the `messages` member off the `.values` of a
// getState(...) result — a checkpoint-history read. ISSUE-M171 R7 is explicit
// that the matcher MUST cover optional chaining + computed bracket access,
// because EVERY live read in the codebase uses the optional-chained computed
// form `state?.values?.["messages"]`; a dot-only matcher would silently pass
// the exact reads it must catch. This suite therefore exercises all four
// member-access forms as positive cases (with the optional computed form
// first), plus near-miss negatives that must NOT fire.
//
// Case names (I1..I4, V1..V6) are kept in the `name` field for grep-ability.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { RuleTester } from "@typescript-eslint/rule-tester";
import type { TSESLint } from "@typescript-eslint/utils";
import { afterAll, describe, test } from "bun:test";

// The rule body is authored as JS with JSDoc and ships no .d.mts sidecar, so
// TypeScript resolves the import to `any`. Re-type at the import boundary.
// @ts-expect-error -- rule body is JS+JSDoc; no .d.mts shipped
import { noCheckpointHistoryRead as noCheckpointHistoryReadUntyped } from "../../eslint/no-checkpoint-history-read.mjs";

const noCheckpointHistoryRead = noCheckpointHistoryReadUntyped as TSESLint.RuleModule<
  "checkpointHistoryRead",
  []
>;

// Bridge @typescript-eslint/rule-tester onto bun:test.
RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = test;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
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

ruleTester.run("no-checkpoint-history-read", noCheckpointHistoryRead, {
  valid: [
    {
      // The post-run interrupt scan reads `.tasks`, not `.values.messages` —
      // explicitly NOT caught (ISSUE-M171 R8).
      name: "V1: reading `.values.tasks` does not fire",
      code: `function f(state: any) {
  return state?.values?.["tasks"];
}
`,
    },
    {
      // `turn-id.ts` reads `.values.turnId` — different member, not caught.
      name: "V2: reading `.values.turnId` does not fire",
      code: `function f(state: any) {
  return state?.values?.turnId;
}
`,
    },
    {
      name: "V3: `.messages` with no `.values` parent does not fire",
      code: `function f(obj: any) {
  return obj.messages;
}
`,
    },
    {
      name: "V4: dynamic computed `.values[key]` does not fire",
      code: `function f(state: any, key: string) {
  return state.values[key];
}
`,
    },
    {
      name: "V5: `.values()` method call does not fire",
      code: `function f(map: Map<string, unknown>) {
  return [...map.values()];
}
`,
    },
    {
      name: "V6: bare eslint-disable-next-line escape hatch silences the rule",
      code: `function f(state: any) {
  // eslint-disable-next-line -- escape hatch test
  return state?.values?.["messages"];
}
`,
    },
  ],
  invalid: [
    {
      // The REAL shape every live read uses (ISSUE-M171 R7) — optional-chained
      // + computed bracket. This MUST be caught.
      name: "I1: optional-chained computed `state?.values?.[\"messages\"]`",
      code: `function f(state: any) {
  return (state?.values?.["messages"] ?? []) as unknown[];
}
`,
      errors: [{ messageId: "checkpointHistoryRead" }],
    },
    {
      name: "I2: optional-chained dotted `postState?.values?.messages`",
      code: `function f(postState: any) {
  return postState?.values?.messages ?? [];
}
`,
      errors: [{ messageId: "checkpointHistoryRead" }],
    },
    {
      name: "I3: plain dotted `state.values.messages`",
      code: `function f(state: any) {
  return state.values.messages;
}
`,
      errors: [{ messageId: "checkpointHistoryRead" }],
    },
    {
      name: "I4: computed bracket `state.values[\"messages\"]`",
      code: `function f(state: any) {
  return state.values["messages"];
}
`,
      errors: [{ messageId: "checkpointHistoryRead" }],
    },
  ],
});
