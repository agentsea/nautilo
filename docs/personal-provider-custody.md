# Personal provider credential custody

This is the storage and recovery contract used by personal provider enrollment
and supported personal-funded execution. The server's personal-key policy is
off by default; an administrator must enable it and the Human must have
`use_personal_provider_credentials`. Source priority is governed by the
[provider funding policy](./server-provider-policy.md).

## Authority and storage

`personal_provider_credentials` stores one current encrypted record per local
Human and supported provider or paid service, including Surplus. AES-256-GCM binds the envelope to the Human, provider,
credential UUID, revision and instance key UUID. Replacement uses an expected
revision; deleting a Human cascades current credentials. Agent and crypto database
roles have no access to the table. Backups retain their usual retention semantics.

The independent master secret is `NAUTILO_PERSONAL_PROVIDER_CUSTODY`, a compact
JSON object containing `formatVersion`, a random `keyId`, and a 32-byte `keyHex`.
It is unrelated to provider API keys, push-token encryption, content encryption,
and portable-backup encryption. The trusted server/operator can decrypt records;
this is not operator-blind storage. Never put the secret in a ticket, command-line
argument, browser response, log, prompt or model execution state.

| Installation | Durable authority |
| --- | --- |
| Source/named instance | The selected instance's `instance.env`, mode 0600. An explicit `NAUTILO_DOTENV_PATH` selects the canonical file. An inherited shell custody value cannot replace it. |
| Local/LAN Compose | Host `runtime-config/instance.env`; the container receives its projection. |
| Remote Compose | Canonical configuration on the deployment host. A different operator workstation preserves that value. |
| Railway | Generated launch custody and the exact server-service variable; versioned launch envelopes keep legacy formats readable. Portable recovery must carry the matching custody with the encrypted data. |

Initial provisioning requires positive evidence that no personal credential rows
exist (or that the pre-feature table does not exist). Read failure, unavailable
database, malformed/blank configuration, or existing ciphertext never authorizes
regeneration. An unavailable custody key disables personal credential operations;
it does not make ordinary server-funded startup fail.

The owner/loopback diagnostic `GET /api/health/personal-provider-custody` returns
only status, whether records exist, an opaque key UUID when available, and a safe
failure code. `ready` means every stored envelope authenticated. `degraded`
means an explicitly reset lost key still has retained, unusable records; current
key records authenticate and restore remains possible. Configuration
diagnostics report presence only, without even a secret prefix. No diagnostic
makes a provider request.

The administrator CLI exposes the same read-only report:

```sh
nautilo doctor personal-provider-custody --profile <profile-name>
```

For a source server on the same host, `--server http://localhost:<server-port>`
uses the endpoint's loopback authority. A remote profile requires an owner
session bound to that exact target. The command never follows authenticated
redirects, prints provider secrets, resets custody or makes a paid request.
A degraded or unavailable report exits unsuccessfully with recovery guidance.

## Backup, restore and moving a server

Move the whole logical instance: database, identity, files and protected canonical
configuration. A database dump alone cannot recover credentials. Quiesce source
writes and paid execution before capture; keep the source quiesced through cutover.
Restore matching custody before admitting traffic, then verify both ordinary
runtime acceptance and the custody diagnostic. API-key re-entry is unnecessary when custody is preserved. ChatGPT subscription
registrations require reconnect after restore: their old renewable tokens are
cleared before execution resumes. Account identity and explicit selection remain,
so this recovery never silently switches a subscription to paid API funding. Do not run paid work on both copies.

Source and Compose restore inspect credential key IDs before replacing the target
database. Full recovery uses the protected source configuration. Data-only Compose
recovery preserves target configuration and refuses a populated credential dump
unless that target already holds matching custody. After startup, populated
credential recovery must authenticate every envelope before reporting success.

QA cloning has deliberately different semantics: discard copied personal
credential rows after rebinding and checking the exact new server identity, omit
source custody and its configuration snapshots, and provision fresh target
custody. Existing usage history remains. Enroll synthetic keys for testing.

## Irretrievable key loss

First check protected backups and the installation's canonical secret authority.
Restore the exact original key whenever possible. If no copy survives, the
plaintext credentials cannot be recovered. Reset requires explicit operator
authorization; startup never performs it automatically.

For file-owned source custody:

1. Turn personal provider keys off. Quiesce personal-funded work and stop the
   server; leave the selected database running. Preserve the damaged state and
   ordinary recovery backup.
2. Read the affected opaque `key_id` from the retained credential records and the
   canonical `server_instance_id`. Neither value is a secret. Confirm the exact
   selected instance before proceeding.
3. From the matching source checkout, run:

   ```sh
   bun bin/nautilo-dev/src/index.ts reset-personal-provider-custody \
     --instance <instance-id> --lost-key-id <lost-key-uuid> \
     --confirm-server <server-uuid> --confirm-reset
   ```

4. The command checks the database identity, disabled policy, and affected rows,
   then atomically persists new custody without removing any records. It prints
   only the new key UUID. The durable custody record carries the lost key UUID as
   reset provenance; retrying with that same UUID reuses the committed
   replacement. Restart and check the persisted key UUID before enrollment.
5. Each affected Human must replace or delete their own credentials through
   Settings → Personal API keys or the account credential API. Replacement does not require the lost key. Until
   then, the old records remain configured but unavailable; they must never be
   treated as absent to permit server-funded fallback. The global diagnostic
   reports `degraded` until those rows are replaced or deleted. A backup made
   during this transition remains restorable with the same reset custody;
   unrelated or unmarked key IDs still fail restore preflight.

Do not use the source reset command against cloud-injected custody: the hosting
authority must own both the durable replacement and its runtime projection. An
operator incident procedure must retain the new value across retries and update
that authority before activating a server. Do not improvise by editing a running
container's environment or deleting credential rows.

## Compatibility and qualification

Railway's signed `topology.migrationSchemaVersion` distinguishes images that can
prove personal credential custody during maintenance. Version 2 requires the
`migrate-custody-v1` and `restore-custody-v1` commands. Publish that contract only
with an image containing these implementations. Legacy version 1 images and
checkpoints retain their ordinary maintenance contract and cannot serve as proof
that a new custody key may be generated.

Mocked deployment tests and local source acceptance are not remote deployment
qualification. Qualify remote Compose and Railway separately on explicitly
authorized disposable targets before claiming those lifecycle paths tested.

## ChatGPT subscriptions

`chatgpt_registrations` stores separate issued-client registrations for each
Human, encrypted with the same operator custody. Each registration retains its
verified account identity and stable Server host identity. Token rotation is
serialized in the database; reconnect changes the authority revision so an
already admitted Task cannot silently adopt a replacement account or grant.
Unfinished first sign-ins retain an encrypted client registration with no tokens
or verified identity. They cannot be selected for inference.

Source and Compose restore require matching custody for subscription-only
backups too. Restore clears renewable tokens and requires reconnect, including
when restoring onto the original Server. This prevents a stale backup from
becoming a second rotating-token custodian. QA clones remove the registrations
entirely. Out-of-band database restores must keep the runtime stopped and clear
subscription token envelopes before it starts; copying a database and custody
key is not permission to run two active copies.

See [Connect a ChatGPT subscription](./chatgpt-subscriptions.md) for supported
clients, model selection, funding switches and account recovery.
