# Reflection candidate-policy evaluation

This directory is the research-only Wave 1 harness from Nautilo ISSUE-M249.
It evaluates candidate neighborhoods; it does not synthesize parents, create a
Record graph, call Sleep, or change production Memory and Journal behavior.

Run the complete offline acceptance command from the repository root:

```bash
bun run --cwd packages/reflection eval:reflection-candidates
```

The command strictly validates the versioned synthetic corpus, recomputes the
machine-readable and human-readable decision artifacts, and fails when either
committed artifact differs. It requires no database, server, credentials,
provider, network request, or mutable local fixture.

Maintainers intentionally changing the corpus or policy may regenerate the
artifacts with:

```bash
bun run --cwd packages/reflection eval:reflection-candidates -- --write
```

Review the full artifact diff before committing. `--print-json` writes the
computed machine report to stdout without touching the repository.

Authority is resolved before any candidate policy receives a semantic view or
requests a similarity from the deterministic fake embedding port. The report
must never contain an inaccessible Record ID, score, provenance value, or
aggregate contribution. Record authority is a disjunction of exact effective-
audience alternatives: attachment Humans are never unioned, and an invocation
carrying the virtual public-boundary marker requires an alternative carrying
that marker.
