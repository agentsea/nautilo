import { expect, test } from "bun:test";
import type { ComputerNativeControlCollection } from "@nautilo/computer-use-contracts/native";
import { nativeObservationDelta } from "../../src/graph/native-observation-delta";

type Row = ComputerNativeControlCollection["controls"][number];
const row = (id: string, label: string, parent?: string): Row => ({ id, role: "button", label,
  ...(parent === undefined ? {} : { parent }), state: { completeness: "partial" } });

test("snapshot IDs and reordered rows do not manufacture history changes", () => {
  const before = [row("c0", "Panel"), row("c1", "One", "c0"), row("c2", "Two", "c0")];
  const after = [row("c20", "Two", "c10"), row("c10", "Panel"), row("c30", "One", "c10")];
  const original = structuredClone({ before, after });
  expect(nativeObservationDelta(before, after)).toMatchObject({ identity: "not_inferred", sameSemanticOccurrences: 3,
    addedOrChanged: [], removedOrChanged: [] });
  expect({ before, after }).toEqual(original);
});

test("duplicates retain occurrence counts without guessing persistent correspondence", () => {
  const before = [row("c0", "Same"), row("c1", "Same")];
  const after = [row("c9", "Same")];
  const delta = nativeObservationDelta(before, after);
  expect(delta.sameSemanticOccurrences).toBe(1);
  expect(delta.removedOrChanged).toHaveLength(1);
  expect(delta.addedOrChanged).toHaveLength(0);
  expect(delta.identity).toBe("not_inferred");
  expect(nativeObservationDelta(after, before).addedOrChanged).toHaveLength(1);
});

test("same labels under different ancestors do not erase changed hierarchy", () => {
  const before = [row("c0", "Left"), row("c1", "Right"), row("c2", "Save", "c0")];
  const after = [row("c10", "Left"), row("c11", "Right"), row("c12", "Save", "c11")];
  const delta = nativeObservationDelta(before, after);
  expect(delta.sameSemanticOccurrences).toBe(2);
  expect(delta.addedOrChanged).toMatchObject([{ label: "Save", ancestors: [{ label: "Right" }] }]);
  expect(delta.removedOrChanged).toMatchObject([{ label: "Save", ancestors: [{ label: "Left" }] }]);
});

test("real value, selection and enabled changes remain exact; missing never means empty", () => {
  const before = [row("c0", "Field")];
  for (const changed of [
    { ...row("c1", "Field"), state: { completeness: "partial" as const, value: "" } },
    { ...row("c1", "Field"), state: { completeness: "partial" as const, value: "Exact 🐙\ntext " } },
    { ...row("c1", "Field"), state: { completeness: "partial" as const, selected: false } },
    { ...row("c1", "Field"), enabled: false },
  ]) {
    const delta = nativeObservationDelta(before, [changed]);
    expect(delta.addedOrChanged[0]).toMatchObject(changed);
    expect(delta.removedOrChanged).toHaveLength(1);
  }
});

test("unresolved or cyclic ancestry never cancels evidence", () => {
  for (const rows of [[row("c0", "Missing", "c1")], [row("c0", "Cycle", "c1"), row("c1", "Cycle", "c0")]]) {
    const delta = nativeObservationDelta(rows, rows);
    expect(delta.sameSemanticOccurrences).toBe(0);
    expect(delta.addedOrChanged).toHaveLength(rows.length);
    expect(delta.addedOrChanged.every(entry => entry.ancestryComplete === false)).toBe(true);
  }
});

test("executable handles do not enter history or determine semantic equality", () => {
  const target = { version: 1 as const, context: `dctx_${"a".repeat(43)}`, reference: `detgt_${"b".repeat(43)}` };
  const before = [{ ...row("c0", "Field"), target }];
  const after = [{ ...row("c7", "Field"), target: { ...target, reference: `detgt_${"c".repeat(43)}` } }];
  expect(nativeObservationDelta(before, after).sameSemanticOccurrences).toBe(1);
  expect(JSON.stringify(nativeObservationDelta([], before))).not.toContain("detgt_");
});

test("large snapshot reindex retains only actual semantic differences without truncating rows", () => {
  const before = Array.from({ length: 600 }, (_, index) => row(`c${index}`, `Control ${index}`));
  const after = before.map((entry, index) => ({ ...entry, id: `c${index + 1000}` }));
  after[300] = { ...after[300]!, state: { completeness: "partial", value: "42" } };
  const delta = nativeObservationDelta(before, after);
  expect(delta.sameSemanticOccurrences).toBe(599);
  expect(delta.addedOrChanged).toHaveLength(1);
  expect(delta.removedOrChanged).toHaveLength(1);
  expect(JSON.stringify(delta).length).toBeLessThan(JSON.stringify(before).length / 10);
  const allChanged = nativeObservationDelta(before, after.map(entry => ({ ...entry, enabled: false })));
  expect(allChanged.addedOrChanged).toHaveLength(600);
  expect(allChanged.removedOrChanged).toHaveLength(600);
});
