import { describe, expect, test } from "bun:test";

import {
  auditCoverageRegistry,
  canonicalDatabaseWriterLocator,
  compareInventory,
  retiredFrozenDebtErrors,
  reviewedDebtLinkErrors,
  type FrozenBaselineDebt,
  type ReviewedDebtLink,
} from "../../src/registry";

const entry = {
  id: "db.capabilities.slug",
  surface: "db",
  locator: "capabilities.slug",
  classification: "public",
  owner: "packages/db",
  readers: ["packages/trust"],
  writers: ["packages/db/src/utils/seed-rbac.ts"],
  migrationState: "not_applicable",
  plaintextReason: "Static public authorization catalogue identifier.",
  retention: "Server lifetime.",
  testEvidence: ["packages/db/tests/unit/sensitive-tables-matrix-complete.test.ts"],
} as const;

const debt = {
  id: "debt.db.session_messages.content",
  surface: "db",
  locator: "session_messages.content",
  owner: "packages/runtime",
  reason: "The Wave 3 bridge repository does not exist yet.",
  remediationState: "planned",
  releaseImpact: "blocks_enabled_scope",
  evidenceGap: "No ciphertext writer or snapshot-negative test exists.",
} as const;

const reviewedLink = {
  id: "debt-link.db.session-messages.preview",
  surface: "db",
  locator: "session_messages.preview",
  owner: "packages/runtime",
  targetDebtIds: [debt.id],
  reason: "This derived preview is another representation of the same frozen content.",
  testEvidence: ["packages/encryption-invariants/tests/unit/registry.test.ts"],
} as const;

describe("coverage registry audit", () => {
  test("accepts unique valid classified and debt locators", () => {
    expect(auditCoverageRegistry({ entries: [entry], debt: [debt], exceptions: [] })).toEqual({
      ok: true,
      counts: {
        classified: 1,
        debt: 1,
        reviewedDebtLinks: 0,
        exceptions: 0,
      },
    });
  });

  test("rejects duplicate IDs and locators across classified and debt records", () => {
    expect(auditCoverageRegistry({
      entries: [entry, { ...entry }],
      debt: [debt, { ...debt, id: entry.id, locator: entry.locator }],
      exceptions: [],
    })).toEqual({
      ok: false,
      errors: [
        "duplicate registry id: db.capabilities.slug",
        "duplicate registry locator: capabilities.slug",
        "registry id collides with baseline debt: db.capabilities.slug",
        "registry locator collides with baseline debt: capabilities.slug",
      ],
    });
  });

  test("rejects every malformed reviewed debt link field", () => {
    expect(auditCoverageRegistry({
      entries: [],
      debt: [],
      reviewedDebtLinks: [{
        id: "Bad",
        surface: "invalid",
        locator: " ",
        owner: " ",
        targetDebtIds: ["", ""],
        reason: "too short",
        testEvidence: ["../not-a-test.txt"],
      }],
      exceptions: [],
    } as never)).toEqual({
      ok: false,
      errors: [
        "Bad: reviewed debt link id must be a stable dotted identifier",
        "Bad: reviewed debt link locator must be non-empty",
        "Bad: reviewed debt link surface is invalid",
        "Bad: reviewed debt link owner must be non-empty",
        "Bad: reviewed debt link must target exact baseline debt IDs",
        "Bad: reviewed debt link target IDs must be unique",
        "Bad: reviewed debt link reason must be descriptive",
        "Bad: reviewed debt link needs executable test evidence",
      ],
    });
  });

  test("reviewed link validation is exact at every collection and path boundary", () => {
    const errorsFor = (overrides: Record<string, unknown>) => {
      const result = auditCoverageRegistry({
        entries: [],
        debt: [],
        reviewedDebtLinks: [{ ...reviewedLink, ...overrides }],
        exceptions: [],
      } as never);
      expect(result.ok).toBe(false);
      return result.ok ? [] : result.errors;
    };

    for (const id of [`!${reviewedLink.id}`, `${reviewedLink.id}!`]) {
      expect(errorsFor({ id })).toContain(
        `${id}: reviewed debt link id must be a stable dotted identifier`,
      );
    }
    expect(errorsFor({ targetDebtIds: [] })).toContain(
      `${reviewedLink.id}: reviewed debt link must target exact baseline debt IDs`,
    );
    for (const targetDebtIds of [[debt.id, ""], [" "]]) {
      expect(errorsFor({ targetDebtIds })).toContain(
        `${reviewedLink.id}: reviewed debt link must target exact baseline debt IDs`,
      );
    }
    expect(errorsFor({ reason: " valid text " })).toContain(
      `${reviewedLink.id}: reviewed debt link reason must be descriptive`,
    );
    expect(auditCoverageRegistry({
      entries: [],
      debt: [],
      reviewedDebtLinks: [{ ...reviewedLink, reason: "exactly-12ch" }],
      exceptions: [],
    })).toEqual({
      ok: true,
      counts: { classified: 0, debt: 0, reviewedDebtLinks: 1, exceptions: 0 },
    });
    expect(errorsFor({ testEvidence: [] })).toContain(
      `${reviewedLink.id}: reviewed debt link needs executable test evidence`,
    );
    for (const testEvidence of [
      [reviewedLink.testEvidence[0], "packages/plain.ts"],
      ["/packages/example.test.ts"],
      ["\\packages/example.test.ts"],
      ["packages/example.test.ts.bak"],
      ["packages/example.ts"],
      ["packages/./example.test.ts"],
      ["packages/../example.test.ts"],
      ["packages//example.test.ts"],
    ]) {
      expect(errorsFor({ testEvidence })).toContain(
        `${reviewedLink.id}: reviewed debt link needs executable test evidence`,
      );
    }
  });

  test("validates cross-boundary projections without wildcard field authority", () => {
    const exactMinimumRationale = "123456789012345678901234";
    expect(auditCoverageRegistry({
      entries: [],
      debt: [],
      reviewedDebtLinks: [{
        ...reviewedLink,
        crossBoundaryProjection: {
          fields: ["exact.field"],
          rationale: "A sufficiently descriptive projection rationale.",
        },
      }],
      exceptions: [],
    })).toEqual({
      ok: true,
      counts: { classified: 0, debt: 0, reviewedDebtLinks: 1, exceptions: 0 },
    });

    const errorsFor = (crossBoundaryProjection: unknown) => {
      const result = auditCoverageRegistry({
        entries: [],
        debt: [],
        reviewedDebtLinks: [{ ...reviewedLink, crossBoundaryProjection }],
        exceptions: [],
      } as never);
      expect(result.ok).toBe(false);
      return result.ok ? [] : result.errors;
    };

    for (const crossBoundaryProjection of [
      { fields: [], rationale: "short" },
      { fields: [""], rationale: "short" },
      { fields: ["exact.field", ""], rationale: exactMinimumRationale },
      { fields: [" "], rationale: exactMinimumRationale },
      { fields: ["field*"], rationale: "short" },
      { fields: [".field"], rationale: "short" },
      { fields: ["field."], rationale: "short" },
    ]) {
      const errors = errorsFor(crossBoundaryProjection);
      expect(errors).toContain(
        `${reviewedLink.id}: cross-boundary projection requires exact database fields`,
      );
      if (crossBoundaryProjection.rationale === "short") {
        expect(errors).toContain(
          `${reviewedLink.id}: cross-boundary projection rationale must be descriptive`,
        );
      }
    }
    expect(auditCoverageRegistry({
      entries: [],
      debt: [],
      reviewedDebtLinks: [{
        ...reviewedLink,
        crossBoundaryProjection: {
          fields: ["exact.field"],
          rationale: exactMinimumRationale,
        },
      }],
      exceptions: [],
    })).toMatchObject({ ok: true });
    expect(errorsFor({
      fields: ["exact.field"],
      rationale: " 1234567890123456789012 ",
    })).toContain(
      `${reviewedLink.id}: cross-boundary projection rationale must be descriptive`,
    );
    const wrongSurface = auditCoverageRegistry({
      entries: [],
      debt: [],
      reviewedDebtLinks: [{
        ...reviewedLink,
        surface: "wire",
        crossBoundaryProjection: {
          fields: ["exact.field"],
          rationale: "A sufficiently descriptive projection rationale.",
        },
      }],
      exceptions: [],
    });
    expect(wrongSurface.ok).toBe(false);
    if (!wrongSurface.ok) {
      expect(wrongSurface.errors).toContain(
        `${reviewedLink.id}: cross-boundary projection requires exact database fields`,
      );
    }
  });

  test("validates retired debt identity, rationale, and executable evidence", () => {
    const result = auditCoverageRegistry({
      entries: [],
      debt: [],
      retiredFrozenDebt: [{
        debtId: "Bad",
        reason: "short",
        testEvidence: [
          "packages/valid.test.ts",
          "packages/../invalid.test.ts",
        ],
      }],
      exceptions: [],
    } as never);
    expect(result).toEqual({
      ok: false,
      errors: [
        "Bad: retired frozen debt ID must be a stable dotted identifier",
        "Bad: retired frozen debt reason must be descriptive",
        "Bad: retired frozen debt needs executable test evidence",
      ],
    });
    const duplicate = {
      debtId: debt.id,
      reason: "The exact legacy boundary has been conclusively retired.",
      testEvidence: ["packages/encryption-invariants/tests/unit/registry.test.ts"],
    } as const;
    expect(auditCoverageRegistry({
      entries: [], debt: [], retiredFrozenDebt: [duplicate, duplicate], exceptions: [],
    })).toEqual({
      ok: false,
      errors: [`duplicate retired frozen debt ID: ${debt.id}`],
    });

    const validRetirement = {
      debtId: "debt.valid.retirement",
      reason: "123456789012345678901234",
      testEvidence: ["packages/example.test.ts"],
    } as const;
    expect(auditCoverageRegistry({
      entries: [], debt: [], retiredFrozenDebt: [validRetirement], exceptions: [],
    })).toMatchObject({ ok: true });

    const retirementErrors = (overrides: Record<string, unknown>) => {
      const result = auditCoverageRegistry({
        entries: [],
        debt: [],
        retiredFrozenDebt: [{ ...validRetirement, ...overrides }],
        exceptions: [],
      } as never);
      expect(result.ok).toBe(false);
      return result.ok ? [] : result.errors;
    };
    for (const debtId of [
      `!${validRetirement.debtId}`,
      `${validRetirement.debtId}!`,
    ]) {
      expect(retirementErrors({ debtId })).toContain(
        `${debtId}: retired frozen debt ID must be a stable dotted identifier`,
      );
    }
    expect(retirementErrors({ reason: " 1234567890123456789012 " })).toContain(
      `${validRetirement.debtId}: retired frozen debt reason must be descriptive`,
    );
    for (const testEvidence of [
      [],
      ["/packages/example.test.ts"],
      ["packages/example.test.ts.bak"],
      ["packages/./example.test.ts"],
    ]) {
      expect(retirementErrors({ testEvidence })).toContain(
        `${validRetirement.debtId}: retired frozen debt needs executable test evidence`,
      );
    }

    expect(auditCoverageRegistry({
      entries: [],
      debt: [],
      retiredFrozenDebt: [
        { ...validRetirement, debtId: "z!" },
        { ...validRetirement, debtId: "a!" },
      ],
      exceptions: [],
    })).toEqual({
      ok: false,
      errors: [
        "z!: retired frozen debt ID must be a stable dotted identifier",
        "a!: retired frozen debt ID must be a stable dotted identifier",
      ],
    });
  });

  test("rejects duplicate reviewed links and collisions with classified or debt records", () => {
    const collidingEntry = {
      ...entry,
      id: reviewedLink.id,
      locator: reviewedLink.locator,
    };
    const collidingDebt = {
      ...debt,
      id: reviewedLink.id,
      locator: reviewedLink.locator,
    };
    const result = auditCoverageRegistry({
      entries: [collidingEntry],
      debt: [collidingDebt],
      reviewedDebtLinks: [reviewedLink, reviewedLink],
      exceptions: [],
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        `duplicate reviewed debt link id: ${reviewedLink.id}`,
        `duplicate reviewed debt link locator: ${reviewedLink.locator}`,
        `registry id collides with baseline debt: ${reviewedLink.id}`,
        `registry locator collides with baseline debt: ${reviewedLink.locator}`,
        `reviewed debt link id collides with registry entry: ${reviewedLink.id}`,
        `reviewed debt link id collides with baseline debt: ${reviewedLink.id}`,
        `reviewed debt link locator collides with registry entry: ${reviewedLink.locator}`,
        `reviewed debt link locator collides with baseline debt: ${reviewedLink.locator}`,
        `reviewed debt link id collides with registry entry: ${reviewedLink.id}`,
        `reviewed debt link id collides with baseline debt: ${reviewedLink.id}`,
        `reviewed debt link locator collides with registry entry: ${reviewedLink.locator}`,
        `reviewed debt link locator collides with baseline debt: ${reviewedLink.locator}`,
      ],
    });
  });
});

describe("inventory comparison", () => {
  test("database writer canonicalization removes only exact raw scanner provenance", () => {
    const raw =
      "packages/db/src/queries/example.ts#write:raw_sql:update:public.example:1";
    const typed =
      "packages/db/src/queries/example.ts#write:update:public.example:1";

    expect(canonicalDatabaseWriterLocator(raw)).toBe(typed);
    expect(canonicalDatabaseWriterLocator(typed)).toBe(typed);
    expect(canonicalDatabaseWriterLocator(
      "packages/db/src/queries/example.ts#write:raw_sql:update:public.example",
    )).toBe(
      "packages/db/src/queries/example.ts#write:raw_sql:update:public.example",
    );
    expect(canonicalDatabaseWriterLocator(
      "packages/db/src/queries/example.ts#write:raw_sql:update:public.example:12",
    )).toBe(
      "packages/db/src/queries/example.ts#write:update:public.example:12",
    );
    expect(canonicalDatabaseWriterLocator(
      "packages/db/src/queries/example.ts#write:raw_sql:update:public.example:1:extra",
    )).toBe(
      "packages/db/src/queries/example.ts#write:raw_sql:update:public.example:1:extra",
    );
  });

  test("retired frozen debt stays in history without becoming a stale declaration", () => {
    const retirement = {
      debtId: debt.id,
      reason: "The exact legacy observation was removed by a source-reviewed contract change.",
      testEvidence: ["packages/encryption-invariants/tests/unit/registry.test.ts"],
    } as const;
    const registry = {
      entries: [],
      debt: [debt],
      retiredFrozenDebt: [retirement],
      exceptions: [],
    } as const;

    expect(retiredFrozenDebtErrors(registry, [debt])).toEqual([]);
    expect(compareInventory({
      observed: [],
      registry,
      frozenBaselineDebt: [debt],
    })).toEqual({ unknown: [], stale: [], unfrozenDebt: [] });
    expect(compareInventory({
      observed: [{ id: "db.legacy", surface: "db", locator: debt.locator }],
      registry,
      frozenBaselineDebt: [debt],
    }).unknown).toEqual([`db:${debt.locator}`]);
  });

  test("retired debt references must resolve to the exact frozen snapshot", () => {
    const retiredFrozenDebt = [{
      debtId: debt.id,
      reason: "The exact legacy observation was removed by a source-reviewed contract change.",
      testEvidence: ["packages/encryption-invariants/tests/unit/registry.test.ts"],
    }] as const;
    expect(retiredFrozenDebtErrors({
      entries: [], debt: [], retiredFrozenDebt, exceptions: [],
    }, [debt])).toEqual([
      `${debt.id}: retired frozen debt target is missing`,
    ]);
    expect(retiredFrozenDebtErrors({
      entries: [], debt: [debt], retiredFrozenDebt, exceptions: [],
    }, [])).toEqual([
      `${debt.id}: retired frozen debt target is not frozen`,
    ]);
    expect(retiredFrozenDebtErrors({
      entries: [], debt: [debt], exceptions: [],
    }, [debt])).toEqual([]);
    expect(retiredFrozenDebtErrors({
      entries: [],
      debt: [],
      retiredFrozenDebt: [
        { ...retiredFrozenDebt[0], debtId: "z.debt" },
        { ...retiredFrozenDebt[0], debtId: "a.debt" },
      ],
      exceptions: [],
    }, [])).toEqual([
      "a.debt: retired frozen debt target is missing",
      "z.debt: retired frozen debt target is missing",
    ]);
  });

  test("retiring one frozen observation does not retire unrelated debt", () => {
    const otherDebt = {
      ...debt,
      id: "debt.db.other.content",
      locator: "other.content",
    } as const;
    const separatelyRetiredDebt = {
      ...debt,
      id: "debt.db.retired-elsewhere.content",
      locator: "retired_elsewhere.content",
    } as const;
    const retirement = (debtId: string) => ({
      debtId,
      reason: "The exact legacy observation has been retired.",
      testEvidence: ["packages/encryption-invariants/tests/unit/registry.test.ts"],
    }) as const;
    expect(compareInventory({
      observed: [
        { id: "db.retired", surface: "db", locator: debt.locator },
        { id: "db.other", surface: "db", locator: otherDebt.locator },
      ],
      registry: {
        entries: [],
        debt: [debt, otherDebt, separatelyRetiredDebt],
        retiredFrozenDebt: [
          retirement(debt.id),
          retirement(separatelyRetiredDebt.id),
        ],
        exceptions: [],
      },
      frozenBaselineDebt: [debt, otherDebt, separatelyRetiredDebt],
    })).toEqual({
      unknown: [`db:${debt.locator}`],
      stale: [],
      unfrozenDebt: [],
    });
  });

  test("an exact reviewed link can inherit only compatible frozen debt", () => {
    const registry = {
      entries: [],
      debt: [debt],
      reviewedDebtLinks: [reviewedLink],
      exceptions: [],
    } as const;

    expect(reviewedDebtLinkErrors(registry, [debt])).toEqual([]);
    expect(compareInventory({
      observed: [{
        id: "db.session_messages.preview",
        surface: "db",
        locator: reviewedLink.locator,
      }],
      registry,
      frozenBaselineDebt: [debt],
    })).toEqual({
      unknown: [],
      stale: ["db:session_messages.content"],
      unfrozenDebt: [],
    });
  });

  test("reviewed inheritance requires every exact target and ignores unrelated debt", () => {
    const unrelated = {
      ...debt,
      id: "debt.db.other.payload",
      locator: "other.payload",
    } as const;
    const observed = [{
      id: "db.session_messages.preview",
      surface: "db",
      locator: reviewedLink.locator,
    }] as const;
    const compare = (
      link: ReviewedDebtLink,
      frozen: readonly FrozenBaselineDebt[] = [debt, unrelated],
    ) =>
      compareInventory({
        observed,
        registry: {
          entries: [],
          debt: [debt, unrelated],
          reviewedDebtLinks: [link],
          exceptions: [],
        },
        frozenBaselineDebt: frozen,
      });

    expect(compare(reviewedLink)).toEqual({
      unknown: [],
      stale: ["db:other.payload", "db:session_messages.content"],
      unfrozenDebt: [],
    });
    expect(compare({ ...reviewedLink, targetDebtIds: [] })).toEqual({
      unknown: ["db:session_messages.preview"],
      stale: ["db:other.payload", "db:session_messages.content"],
      unfrozenDebt: [],
    });
    expect(compare({
      ...reviewedLink,
      targetDebtIds: [debt.id, "debt.db.missing.payload"],
    })).toEqual({
      unknown: ["db:session_messages.preview"],
      stale: ["db:other.payload", "db:session_messages.content"],
      unfrozenDebt: [],
    });
    expect(compare(reviewedLink, [unrelated])).toEqual({
      unknown: ["db:session_messages.preview"],
      stale: ["db:other.payload"],
      unfrozenDebt: [
        "debt.db.session_messages.content:db:session_messages.content",
      ],
    });
  });

  test("database boundary comparison preserves raw and dotted structure", () => {
    const nestedDebt = {
      ...debt,
      id: "debt.db.public.session_messages.content",
      locator: "public.session_messages.content",
    } as const;
    const rawDebt = {
      ...debt,
      id: "debt.db.raw.session_messages.content",
      locator: ":raw_sql:session_messages:content",
    } as const;
    for (const [candidateDebt, locator] of [
      [nestedDebt, "public.session_messages.preview"],
      [rawDebt, ":raw_sql:session_messages:content"],
    ] as const) {
      expect(reviewedDebtLinkErrors({
        entries: [],
        debt: [candidateDebt],
        reviewedDebtLinks: [{
          ...reviewedLink,
          locator,
          targetDebtIds: [candidateDebt.id],
        }],
        exceptions: [],
      }, [candidateDebt])).toEqual([]);
    }
  });

  test("reviewed links fail closed for non-frozen, missing, or incompatible targets", () => {
    expect(reviewedDebtLinkErrors({
      entries: [],
      debt: [debt],
      reviewedDebtLinks: [reviewedLink],
      exceptions: [],
    }, [])).toEqual([
      `${reviewedLink.id}: reviewed debt link target is not frozen: ${debt.id}`,
    ]);

    expect(reviewedDebtLinkErrors({
      entries: [],
      debt: [],
      reviewedDebtLinks: [reviewedLink],
      exceptions: [],
    }, [debt])).toEqual([
      `${reviewedLink.id}: reviewed debt link target is missing: ${debt.id}`,
    ]);

    expect(reviewedDebtLinkErrors({
      entries: [],
      debt: [debt],
      reviewedDebtLinks: [{
        ...reviewedLink,
        locator: "other_table.preview",
      }],
      exceptions: [],
    }, [debt])).toEqual([
      `${reviewedLink.id}: reviewed debt link database boundary other_table does not match target ${debt.id} boundary session_messages`,
    ]);
  });

  test("reviewed links reject surface mismatches and malformed raw SQL boundaries", () => {
    expect(reviewedDebtLinkErrors({
      entries: [],
      debt: [debt],
      reviewedDebtLinks: [{
        ...reviewedLink,
        surface: "wire",
      }],
      exceptions: [],
    }, [debt])).toEqual([
      `${reviewedLink.id}: reviewed debt link surface wire does not match target ${debt.id} surface db`,
    ]);

    expect(reviewedDebtLinkErrors({
      entries: [],
      debt: [debt],
      reviewedDebtLinks: [{
        ...reviewedLink,
        locator: "writer:raw_sql:other_table:content",
      }, {
        ...reviewedLink,
        id: "debt-link.db.session-messages.malformed-raw",
        locator: "writer:raw_sql:session_messages",
      }],
      exceptions: [],
    }, [debt])).toEqual([
      "debt-link.db.session-messages.malformed-raw: reviewed debt link database boundary unknown does not match target debt.db.session_messages.content boundary session_messages",
      `${reviewedLink.id}: reviewed debt link database boundary other_table:content does not match target ${debt.id} boundary session_messages`,
    ]);
  });

  test("non-database links never inherit database-boundary rules", () => {
    const wireDebt = {
      ...debt,
      id: "debt.wire.runtime.response",
      surface: "wire",
      locator: "runtime.response",
    } as const;
    expect(reviewedDebtLinkErrors({
      entries: [],
      debt: [wireDebt],
      reviewedDebtLinks: [{
        ...reviewedLink,
        surface: "wire",
        locator: "different.response",
        targetDebtIds: [wireDebt.id],
      }],
      exceptions: [],
    }, [wireDebt])).toEqual([]);
  });

  test("database links require explicit field evidence for cross-table projections", () => {
    expect(reviewedDebtLinkErrors({
      entries: [],
      debt: [debt],
      reviewedDebtLinks: [{
        ...reviewedLink,
        locator: "public.codex_user_input_requests.questions",
        crossBoundaryProjection: {
          fields: ["questions"],
          rationale:
            "The bounded question projection repeats Human-facing Task prompt content.",
        },
      }],
      exceptions: [],
    }, [debt])).toEqual([]);
  });

  test("database boundary errors preserve unknown and multi-segment identities", () => {
    const cases = [
      {
        target: { ...debt, locator: "malformed" },
        locator: "also-malformed",
        linked: "unknown",
        targetBoundary: "unknown",
      },
      {
        target: { ...debt, locator: "public.beta.content" },
        locator: "public.alpha.preview",
        linked: "public.alpha",
        targetBoundary: "public.beta",
      },
      {
        target: { ...debt, locator: "publicalpha.content" },
        locator: "public.alpha.preview",
        linked: "public.alpha",
        targetBoundary: "publicalpha",
      },
    ] as const;
    for (const item of cases) {
      expect(reviewedDebtLinkErrors({
        entries: [],
        debt: [item.target],
        reviewedDebtLinks: [{
          ...reviewedLink,
          locator: item.locator,
          targetDebtIds: [item.target.id],
        }],
        exceptions: [],
      }, [item.target])).toEqual([
        `${reviewedLink.id}: reviewed debt link database boundary ${item.linked} does not match target ${item.target.id} boundary ${item.targetBoundary}`,
      ]);
    }

    const twoPartTarget = {
      ...debt,
      id: "debt.db.public-session-messages",
      locator: "public.session_messages",
    } as const;
    expect(reviewedDebtLinkErrors({
      entries: [],
      debt: [twoPartTarget],
      reviewedDebtLinks: [{
        ...reviewedLink,
        locator: "public.other",
        targetDebtIds: [twoPartTarget.id],
      }],
      exceptions: [],
    }, [twoPartTarget])).toEqual([
      `${reviewedLink.id}: reviewed debt link database boundary public.other does not match target ${twoPartTarget.id} boundary public.session_messages`,
    ]);
  });

  test("inventory inheritance requires the link surface to match its frozen target", () => {
    expect(compareInventory({
      observed: [{ id: "wire.preview", surface: "wire", locator: reviewedLink.locator }],
      registry: {
        entries: [],
        debt: [debt],
        reviewedDebtLinks: [{ ...reviewedLink, surface: "wire" }],
        exceptions: [],
      },
      frozenBaselineDebt: [debt],
    })).toEqual({
      unknown: [`wire:${reviewedLink.locator}`],
      stale: ["db:session_messages.content"],
      unfrozenDebt: [],
    });
  });

  test("reports new unknowns and stale declarations deterministically", () => {
    const result = compareInventory({
      observed: [
        { id: "db.session_messages.content", surface: "db", locator: "session_messages.content" },
        { id: "db.capabilities.slug", surface: "db", locator: "capabilities.slug" },
      ],
      registry: { entries: [entry], debt: [], exceptions: [] },
      frozenBaselineDebt: [],
    });
    expect(result).toEqual({
      unknown: ["db:session_messages.content"],
      stale: [],
      unfrozenDebt: [],
    });

    const stale = compareInventory({
      observed: [],
      registry: { entries: [entry], debt: [debt], exceptions: [] },
      frozenBaselineDebt: [debt],
    });
    expect(stale).toEqual({
      unknown: [],
      stale: ["db:capabilities.slug", "db:session_messages.content"],
      unfrozenDebt: [],
    });
  });

  test("only the committed initial snapshot can grandfather baseline debt", () => {
    const newObservation = {
      id: "db.new_table.payload",
      surface: "db",
      locator: "new_table.payload",
    } as const;
    const newlyDeclaredDebt = {
      ...debt,
      id: "debt.db.new_table.payload",
      locator: newObservation.locator,
    } as const;

    expect(compareInventory({
      observed: [
        {
          id: "db.session_messages.content",
          surface: "db",
          locator: "session_messages.content",
        },
        newObservation,
      ],
      registry: {
        entries: [],
        debt: [debt, newlyDeclaredDebt],
        exceptions: [],
      },
      frozenBaselineDebt: [debt],
    })).toEqual({
      unknown: ["db:new_table.payload"],
      stale: [],
      unfrozenDebt: ["debt.db.new_table.payload:db:new_table.payload"],
    });
  });

  test("grandfathering requires an exact frozen debt ID, surface, and locator", () => {
    const changedId = {
      ...debt,
      id: "debt.db.session_messages.renamed",
    } as const;
    const changedLocator = {
      ...debt,
      locator: "session_messages.renamed",
    } as const;
    const changedSurface = {
      ...debt,
      surface: "wire",
    } as const;

    for (const candidate of [changedId, changedLocator, changedSurface]) {
      expect(compareInventory({
        observed: [{
          id: "db.fixture",
          surface: candidate.surface,
          locator: candidate.locator,
        }],
        registry: { entries: [], debt: [candidate], exceptions: [] },
        frozenBaselineDebt: [debt],
      })).toEqual({
        unknown: [`${candidate.surface}:${candidate.locator}`],
        stale: [],
        unfrozenDebt: [
          `${candidate.id}:${candidate.surface}:${candidate.locator}`,
        ],
      });
    }
  });

  test("sorts multiple unfrozen debt failures independently of registry order", () => {
    const alpha = {
      ...debt,
      id: "debt.db.alpha.payload",
      locator: "alpha.payload",
    } as const;
    const zeta = {
      ...debt,
      id: "debt.wire.zeta.payload",
      surface: "wire",
      locator: "zeta.payload",
    } as const;

    expect(compareInventory({
      observed: [
        { id: "wire.zeta.payload", surface: "wire", locator: "zeta.payload" },
        { id: "db.alpha.payload", surface: "db", locator: "alpha.payload" },
      ],
      registry: { entries: [], debt: [zeta, alpha], exceptions: [] },
      frozenBaselineDebt: [],
    })).toEqual({
      unknown: ["db:alpha.payload", "wire:zeta.payload"],
      stale: [],
      unfrozenDebt: [
        "debt.db.alpha.payload:db:alpha.payload",
        "debt.wire.zeta.payload:wire:zeta.payload",
      ],
    });
  });

  test("a new observation passes only after it is classified, not newly grandfathered", () => {
    const newObservation = {
      id: "db.capabilities.slug",
      surface: "db",
      locator: "capabilities.slug",
    } as const;

    expect(compareInventory({
      observed: [newObservation],
      registry: { entries: [entry], debt: [], exceptions: [] },
      frozenBaselineDebt: [debt],
    })).toEqual({
      unknown: [],
      stale: [],
      unfrozenDebt: [],
    });
  });

  test("does not silently let an exception classify an observation", () => {
    const result = compareInventory({
      observed: [{ id: "processor.example", surface: "processor", locator: "processor.example" }],
      registry: {
        entries: [],
        debt: [],
        exceptions: [{
          id: "exception.processor.example",
          owner: "packages/server",
          scope: ["processor.example"],
          reason: "The external sandbox cannot yet attest deletion.",
          compensatingControls: ["Output is never persisted outside fixtures."],
          testEvidence: ["packages/server/tests/integration/processor-cleanup.test.ts"],
          reviewBy: "2026-10-01",
          releaseImpact: "blocks_whole_product_claim",
        }],
      },
      frozenBaselineDebt: [],
    });
    expect(result).toEqual({
      unknown: ["processor:processor.example"],
      stale: [],
      unfrozenDebt: [],
    });
  });
});
