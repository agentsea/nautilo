# Limit preflight

Canonical developer-only Codex skill for investigating repository limit
observations. The deterministic scanner lives in `packages/limit-invariants`;
this bundle owns the semantic review procedure.

Install it with:

```bash
bash dev/tools/install-all.sh limit-preflight
```

The installer projects `codex/skills/limit-preflight/` into the selected Codex
home. It does not register a Genie skill, Nautilo runtime tool, server route,
capability, or product catalogue entry.

Run the repeatable, non-CI semantic lane with an explicit model and retain its
receipt:

```bash
bun run limits:eval-agent --model gpt-5.6-sol
```

The harness supplies the canonical skill and every review scenario to the live
agent, then mechanically validates the human-authored expected classifications,
dispositions, review obligations, and forbidden-shortcut rejection. It does not
infer legitimacy itself.
