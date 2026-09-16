# Verify a packaged Slides image

Run the verifier from a clean repository checkout after building the final
runtime image with the default Slides inclusion and a full source revision:

```sh
source_sha="$(git rev-parse HEAD)"
image="nautilo-slides-qualification"

docker buildx build --load --progress=plain \
  -f packaging/docker/Dockerfile \
  --build-arg NAUTILO_SOURCE_SHA="$source_sha" \
  -t "$image" .

bun packaging/wafflebase/verify-slides-image.mjs "$image" "$source_sha"
```

The command first verifies that the local image's
`org.opencontainers.image.revision` label exactly equals the expected full
40- or 64-character revision. It then addresses the image by its immutable ID
and runs one short-lived container with networking disabled, a read-only root
filesystem, and no database or user-data mounts. It mounts only the verifier,
Writer source directory and two Slides artwork files from the checkout, all
read-only.

The container verifies:

- every Slides engine file against `engine/provenance.json`;
- the emitted Node and browser entrypoints and required Node exports;
- a browser bundle of the packaged Slides mini-app;
- the intended package boundary: Slides, Sheets and Writer present, Notes and
  Board absent;
- byte-for-byte parity between packaged Writer production files and the clean
  checkout, permitting checkout-only test files;
- byte-for-byte parity for the Slides icon and preview image; and
- the exact icon, preview and accessible preview text in the built Workbench
  registry bundle.

The verifier prints a JSON receipt on success and exits nonzero on the first
failed invariant. It does not start the Nautilo service or prove authenticated
installation, editing, recovery, conversion fidelity, upgrade, backup, or
rollback behavior.
