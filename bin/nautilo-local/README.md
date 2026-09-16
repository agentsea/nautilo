# nautilo-local

Shared local-development infrastructure used by the administrator CLI,
`nautilo-dev`, Compose deployment, and Docker bootstrap.

The former server-plus-TUI wrapper has been retired. Start local development
with the supported instance workflow:

```bash
bun run infra:start -- --instance <id>
bun run server:start -- --instance <id>
bun run dev-stack -- --instance <id>
```

The package intentionally keeps the `@nautilo/local/bootstrap-logto` export.
Its TUI-named Logto application identifiers are legacy compatibility contracts
used by CLI browser and device authentication; do not rename them as client UI
cleanup.
