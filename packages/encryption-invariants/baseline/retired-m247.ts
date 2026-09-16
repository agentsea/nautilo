import type { RetiredFrozenDebt } from "../src/registry";

/** Frozen source debt retired when the Nautilo TUI product surface was deleted. */
export const RETIRED_M247_FROZEN_DEBT: readonly RetiredFrozenDebt[] = [
  {
    debtId: "debt.source.log.tui-crash",
    reason:
      "M247 deleted the TUI application and its crash-log boundary; the frozen debt row remains as audit history.",
    testEvidence: ["apps/cli/tests/unit/no-arg-and-retired-tui.test.ts"],
  },
];
