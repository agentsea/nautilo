# Compose lifecycle

`@nautilo/compose-lifecycle` is the importable application boundary for one
explicitly named Nautilo Compose target. It wraps the existing Compose driver;
it does not shell out to the Nautilo CLI or parse terminal output.

```ts
const lifecycle = createProductionComposeLifecycle({
  profile,
  templateDir,
  operatorHome,
  releaseActiveWorkReadiness,
  maintenanceDrain,
  ports: {
    progress(event) {},
    clearOwnerClaimCustody: async (profile) => {},
  },
});

await lifecycle.deploy();
const state = await lifecycle.inspect();
const backup = await lifecycle.backup({ toPath });
await lifecycle.upgrade({ artifact: "image", imageRef, scope: "full" });
await lifecycle.restore({ fromPath: backup.backupPath, force: true });
await lifecycle.destroyHard();
```

The profile, template path, operator home, authority, maintenance gates,
progress sink, and custody adapter are caller-owned inputs. Results and
progress events are intentionally bounded and contain no credentials. Because
the underlying driver temporarily selects an instance through process state,
the package serializes lifecycle operations across lifecycle objects.

`buildComposeReleaseReadiness` and `buildComposeMaintenanceDrain` own the
shared fail-closed readiness and drain state machines. Callers provide only
their authenticated transport/API adapters; the CLI and future control plane
therefore do not implement competing upgrade coordination.

First-owner claim installation is a separate resumable protocol:
`prepareComposeOwnerStage` returns a JSON-safe checkpoint without the claim;
`advanceComposeOwnerStage` performs one observe/install/reconcile step; and
`observeComposeOwnerStage` performs a read-only observation. Browser handoff,
polling, signals, output, and concrete keyring storage remain caller adapters.

The Docker-backed qualification is explicit and is never part of unit tests:

```sh
NAUTILO_RUN_COMPOSE_LIFECYCLE_INTEGRATION=1 \
NAUTILO_COMPOSE_TEMPLATE_DIR=/absolute/path/to/templates \
NAUTILO_COMPOSE_INTEGRATION_IMAGE=ghcr.io/agentsea/nautilo-runtime@sha256:<digest> \
bun run --cwd packages/compose-lifecycle test:integration
```

It uses a unique non-default instance, journals ownership before mutation,
calls this package directly, and preserves the target when cleanup ownership
cannot be proven.
