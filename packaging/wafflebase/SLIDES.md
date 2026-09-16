# Slides artifact qualification

Slides uses the owned Core, Docs and Slides source packages. The Docs package is
an engine dependency; this does not migrate Writer or install Notes or Board.

Prepare the local mini-app engine from the repository root:

```sh
bun run slides:prepare
```

The production Docker recipe includes Slides by default:

```sh
docker build \
  --build-arg NAUTILO_SOURCE_SHA="$(git rev-parse HEAD)" \
  -f packaging/docker/Dockerfile -t nautilo-slides-qualification .
```

The source Compose overlay forwards `NAUTILO_WAFFLEBASE_SLIDES`; its default is
`1`. Minimal builds may explicitly set it to `0`. Registry deployments consume
the selected image and cannot add or remove Slides with a runtime environment
variable. Invalid Slides build selections fail rather than silently omitting it.

The `wafflebase-slides-build` stage builds the owned dependency closure and
assembles browser/Node bundles, declarations, dictionaries, licenses and a hash
manifest. Workstation-generated engine directories are excluded from Docker's
build context. The runtime copies only the prepared app, plus the host tool
contract required even when Slides is omitted.

On first installation, Slides is enabled. If a Human disables it, source refreshes
and restarts preserve that choice. A missing or invalid engine must not replace
the installed app. Rollback uses the previously qualified image and preserves
canonical presentation documents.

An artifact-stage build and bundle smoke test are not full installed-runtime
acceptance. Release qualification still verifies the final image, authenticated
installation, editing, save/reopen, Human/Genie conflicts, interruption recovery,
and the separately tracked conversion and source-limit gates.
