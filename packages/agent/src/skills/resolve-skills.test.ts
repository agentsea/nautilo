import { describe, expect, test } from "bun:test";
import { mergeOfficialWithDbRows } from "./resolve-skills";
import type { SkillBody } from "./select-skills-for-turn";

function skill(
  name: string,
  body: string,
  opts?: Partial<Pick<SkillBody, "id" | "description" | "requiresTools">>,
): SkillBody {
  return {
    id: opts?.id ?? `id-${name}`,
    name,
    description: opts?.description ?? `${name} description`,
    body,
    requiresTools: opts?.requiresTools ?? [],
  };
}

describe("mergeOfficialWithDbRows", () => {
  test("official-only returns sorted official skills", () => {
    const official = [
      skill("zebra", "z-body", { id: "official:zebra" }),
      skill("alpha", "a-body", { id: "official:alpha" }),
    ];

    const result = mergeOfficialWithDbRows(official, []);

    expect(result.map((s) => s.name)).toEqual(["alpha", "zebra"]);
    expect(result).toHaveLength(2);
  });

  test("DB-only rows are appended", () => {
    const dbRows = [skill("user-skill", "user body")];

    const result = mergeOfficialWithDbRows([], dbRows);

    expect(result).toEqual(dbRows);
  });

  test("DB shadows official by name — DB body wins, count unchanged", () => {
    const official = [
      skill("shared-name", "official body", { id: "official:shared-name" }),
      skill("official-only", "official only", { id: "official:official-only" }),
    ];
    const dbRows = [skill("shared-name", "db fork body", { id: "db-1" })];

    const result = mergeOfficialWithDbRows(official, dbRows);

    expect(result).toHaveLength(2);
    expect(result.map((s) => s.name)).toEqual(["official-only", "shared-name"]);
    const shadowed = result.find((s) => s.name === "shared-name");
    expect(shadowed?.body).toBe("db fork body");
    expect(shadowed?.id).toBe("db-1");
  });

  test("DB-only rows appended alongside official", () => {
    const official = [skill("alpha", "alpha body", { id: "official:alpha" })];
    const dbRows = [skill("beta", "beta body", { id: "db-beta" })];

    const result = mergeOfficialWithDbRows(official, dbRows);

    expect(result.map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(result).toHaveLength(2);
  });

  test("result sorted by name ascending", () => {
    const official = [
      skill("charlie", "c", { id: "official:charlie" }),
      skill("alpha", "a", { id: "official:alpha" }),
    ];
    const dbRows = [skill("bravo", "b", { id: "db-bravo" })];

    const result = mergeOfficialWithDbRows(official, dbRows);

    expect(result.map((s) => s.name)).toEqual(["alpha", "bravo", "charlie"]);
  });

  test("no duplicate names in output", () => {
    const official = [
      skill("dup", "official", { id: "official:dup" }),
      skill("solo", "solo official", { id: "official:solo" }),
    ];
    const dbRows = [
      skill("dup", "db shadow", { id: "db-dup" }),
      skill("extra", "db extra", { id: "db-extra" }),
    ];

    const result = mergeOfficialWithDbRows(official, dbRows);
    const names = result.map((s) => s.name);

    expect(names).toEqual([...new Set(names)].sort((a, b) => a.localeCompare(b)));
    expect(result).toHaveLength(3);
  });
});
