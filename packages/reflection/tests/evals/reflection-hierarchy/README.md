# Reflection synthetic hierarchy evaluation

This deterministic, offline harness exercises the Wave 3 fixture adapters,
selected candidate policy, Organizer, open DAG, Sleep, search, and evidence
retrieval. It reads no product source and needs no server, database, network,
provider, or credential.

```bash
bun run --cwd packages/reflection eval:reflection-hierarchy
```

Committed artifacts are checked by default. `--write` is explicit maintenance
mode and must be followed by human review of both artifact files.
