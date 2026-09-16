# Official skill evaluation

Run the keyless, deterministic SkillEvaluator checks for Nautilo's bundled
official skills:

```bash
bun run eval:official-skills
```

The Bun entrypoint reads the canonical skills from
`packages/agent/src/skills/bundled/`, creates temporary standard
`<skill>/SKILL.md` packages, and runs schema, PII, license, Unicode, quality,
and script-lint checks. It never creates a second maintained copy of a skill,
and the projected instruction body must remain byte-for-byte identical to the
runtime body.

SkillEvaluator is pinned to immutable commit
`799f9d61d3f22afaf6eb151f8a46236262ca797d`. `uv.lock` freezes its complete
Python dependency graph, and `pyproject.toml` requires the exact supported uv
and Python versions. The evaluator's isolated build requirements are also exact
constraints. The first run creates an ignored local virtual environment.

JSON reports replace the prior local run under `.results/`. The command
preserves SkillEvaluator's exit status: findings that remain blocking make the
Bun target fail. The checked-in policy documents three advisory compatibility
exceptions: repository-owned temporary projections do not invent separate
email-formatted author identities for each bundled skill; the evaluator's
5,000-token efficiency recommendation and macOS example home paths remain
review advisories rather than release failures.

The dedicated `Nightly official skill evaluation` GitHub Actions workflow runs
the same target once per day and on manual dispatch. It provisions the exact
Python runtime required by `pyproject.toml` before invoking the evaluator and
uploads the JSON reports for 14 days. The workflow is deliberately absent from
push and pull-request events, so it does not extend ordinary CI or become a
required PR check.

This target does not run semantic overlap or live model evaluation or use API
keys. Those are separate OSS-013 slices.
