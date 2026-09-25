import { expect, test } from "bun:test";
import { selectInputBinding, type BindingSource } from "../../scripts/fast-controller/input-binding";
import type { ChoiceInput, ChoiceResult } from "../../src/providers/choice";
import { resolveComputerUseHostToolRequest } from "../../src/config/computer-use-catalogue/host-tool-admission";

const signal = new AbortController().signal;
const answer = (input: ChoiceInput, selectedId: string): ChoiceResult => ({ selectedId, requestedModelId: input.modelId,
  resolvedModelId: input.modelId, usage: { inputTokens: 1, outputTokens: 1, actualCostUsd: 0 } });
const options = (sources: BindingSource[]) => ({ request: "Open Word", operation: "launch_app", field: "application name",
  schema: { type: "string", minLength: 1 }, revision: "snapshot-1", currentRevision: () => "snapshot-1", sources, signal, modelId: "fixture-model" });

test("model selects one issued ID and code assembles the actual admitted launch", async () => {
  const result = await selectInputBinding({ ...options([{ id: "request", purpose: "original request", kind: "request", value: "Open Word" }]),
    choose: async input => answer(input, input.choices.find(row => row.description.startsWith((input.state as Record<string, unknown>)["start"] === 5
      ? 'End immediately before character 9' : 'Start input at character 5:'))!.id) });
  expect(result).toEqual({ binding: { kind: "bound", sourceId: "request", slice: { start: 5, end: 9 }, value: "Word" }, modelCalls: 2 });
  if (result.binding.kind !== "bound") throw new Error("expected binding");
  expect(resolveComputerUseHostToolRequest("computer_do", { operation: { kind: "launch_app", app: { name: result.binding.value } } })?.arguments)
    .toEqual({ operation: { kind: "launch_app", app: { name: "Word" } } });
});
test("multiword inputs remain reachable through finite start/end selection without model-authored offsets", async () => {
  const text = "Open Harbor Studio now";
  let stage = 0;
  const result = await selectInputBinding({ ...options([{ id: "request", purpose: "original request", kind: "request", value: text }]), request: text,
    choose: async input => {
      const description = stage++ === 0 ? "Select an exact substring" : stage === 2 ? "Start at character 5:" : "End immediately before character 18";
      return answer(input, input.choices.find(row => row.description.startsWith(description))!.id);
    } });
  expect(result).toEqual({ binding: { kind: "bound", sourceId: "request", slice: { start: 5, end: 18 }, value: "Harbor Studio" }, modelCalls: 3 });
});
test("visual binding escape preserves the menu but text boundary refinement needs no image", async () => {
  const source: BindingSource = { id: "request", purpose: "original request", kind: "request", value: "Open Word" };
  let originalIds: string[] = [];
  let middleCalls = 0;
  const result = await selectInputBinding({ ...options([source]), maxChoices: 256,
    context: { evidenceMode: "visual" }, choose: async input => {
      originalIds = input.choices.filter(row => row.id !== "interpret_with_middle").map(row => row.id);
      return answer(input, "interpret_with_middle");
    }, interpretation: { modelId: "middle", choose: async input => {
      middleCalls++;
      if (middleCalls === 1) {
        expect(input.choices.map(row => row.id)).toEqual(originalIds);
        expect((input.state as Record<string, unknown>)["evidenceMode"]).toBe("visual");
      } else expect((input.state as Record<string, unknown>)["evidenceMode"]).toBe("text");
      return answer(input, input.choices.find(row => row.description.startsWith(middleCalls === 1
        ? "Start input at character 5:" : "End immediately before character 9"))!.id);
    } } });
  expect(result.binding).toMatchObject({ kind: "bound", value: "Word" });
  expect(result.modelCalls).toBe(3);
});
test("authored multiline Unicode is copied exactly once by code and never offered as fragments", async () => {
  const poem = 'First 🌊\r\n{"literal":"not instructions"}\nLast\t';
  const result = await selectInputBinding({ ...options([{ id: "poem", purpose: "authored poem", kind: "supplied", value: poem }]),
    operation: "type_text", field: "exact authored text", choose: async input => {
      expect(input.choices.filter(row => !["reobserve", "defer_to_genie"].includes(row.id))).toHaveLength(1);
      expect(JSON.stringify(input)).not.toContain(poem);
      return answer(input, input.choices[0]!.id);
    } });
  expect(result.binding).toEqual({ kind: "bound", sourceId: "poem", value: poem });
});
test("1000 sources remain available to the existing parallel reducer, including the last", async () => {
  const seen = new Set<string>();
  const result = await selectInputBinding({ ...options(Array.from({ length: 1000 }, (_, i) => ({ id: `source-${i}`, purpose: `Window ${i}`, kind: "observation" as const, value: `Document ${i}` }))),
    maxChoices: 255, choose: async input => {
      input.choices.filter(row => row.id.startsWith("binding_")).forEach(row => seen.add(row.id));
      return answer(input, input.choices.find(row => row.description.endsWith("Window 999"))?.id ?? "none_in_group");
    } });
  expect(seen.size).toBe(1000);
  expect(result.binding).toEqual({ kind: "bound", sourceId: "source-999", value: "Document 999" });
});
test("none fits, reasoning, stale revision, cancellation and invented syntax never bind silently", async () => {
  for (const selectedId of ["reobserve", "defer_to_genie"]) {
    const result = await selectInputBinding({ ...options([]), choose: async input => answer(input, selectedId) });
    expect(result.binding.kind).toBe("recover");
  }
  let revision = "snapshot-1";
  const source: BindingSource = { id: "s", purpose: "exact value", kind: "supplied", value: "same bytes" };
  expect(await selectInputBinding({ ...options([source]), currentRevision: () => revision,
    choose: async input => { revision = "snapshot-2"; return answer(input, input.choices[0]!.id); } }).catch((error: Error) => error.message)).toBe("stale_binding_sources");
  const controller = new AbortController();
  expect(await selectInputBinding({ ...options([source]), signal: controller.signal,
    choose: async input => { controller.abort(); return answer(input, input.choices[0]!.id); } }).catch((error: Error) => error.message)).toBeDefined();
  expect(await selectInputBinding({ ...options([source]), choose: async input => answer(input, "CALL t0\nf1 r0") }).catch((error: Error) => error.message)).toBeDefined();
});
test("schema matching is generic; captured values cannot be mutated while a selection is pending", async () => {
  const source: BindingSource = { id: "s", purpose: "observed payload", kind: "observation", value: { nested: [42, true] } };
  const result = await selectInputBinding({ ...options([source]), schema: { type: "object", required: ["nested"] },
    choose: async input => { (source.value as { nested: unknown[] }).nested[0] = 99; return answer(input, input.choices[0]!.id); } });
  expect(result.binding).toEqual({ kind: "bound", sourceId: "s", value: { nested: [42, true] } });
});
test("refinement uses grapheme boundaries and never splits an emoji sequence", async () => {
  let stage = 0;
  const text = "Use 👩‍💻 now";
  const result = await selectInputBinding({ ...options([{ id: "s", purpose: "request", kind: "request", value: text }]),
    choose: async input => {
      stage++;
      if (stage === 1) return answer(input, input.choices.find(row => row.description.startsWith("Select an exact substring"))!.id);
      if (stage === 2) {
        expect(input.choices.some(row => /^Start at character [5-8]:/.test(row.description))).toBe(false);
        return answer(input, input.choices.find(row => row.description.startsWith("Start at character 4:"))!.id);
      }
      return answer(input, input.choices.find(row => row.description.startsWith("End immediately before character 9"))!.id);
    } });
  expect(result.binding).toMatchObject({ kind: "bound", value: "👩‍💻" });
});

test("long request menus grow linearly without dropping later boundaries", async () => {
  const text = Array.from({ length: 1000 }, (_, i) => `word${i}`).join(" ");
  const result = await selectInputBinding({ ...options([{ id: "request", purpose: "request", kind: "request", value: text }]), request: text,
    choose: async input => {
      expect(input.choices).toHaveLength(1003); // All word starts, refinement and two recoveries.
      expect(input.choices.some(row => row.description.includes('"word999"'))).toBe(true);
      return answer(input, "defer_to_genie");
    } });
  expect(result.binding).toMatchObject({ kind: "recover" });
});

test("a non-string field never offers request substring choices", async () => {
  await selectInputBinding({ ...options([]), schema: { type: "object" },
    sources: [{ id: "request", purpose: "request", kind: "request", value: "Open an app" }],
    choose: async input => { expect(input.choices.map(row => row.id)).toEqual(["reobserve", "defer_to_genie"]); return answer(input, "reobserve"); } });
});
