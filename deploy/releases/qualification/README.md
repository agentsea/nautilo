# Railway release qualification

Official hosting manifests and qualification bundles are assembled outside this
source tree. Normal Railway operations resolve the signed hosting stable channel
using the CLI's pinned public trust root. The checked-in runtime/bootstrap records
and external-image lock in this directory are historical test fixtures; they do
not select today's release or authorize new image publication.

A private qualification bundle may be supplied through the existing
`NAUTILO_RAILWAY_QUALIFICATION_*` consumer contract. Verify its exact manifest,
public trust root, two image records and independently approved source/digests
before using it. A trust root supplied alongside a bundle is operator-selected
qualification authority, never a replacement for the production trust root.
This repository contains no official qualification signer.

If signature, image inspection, CLI verification or pre-mutation planning fails,
do not deploy or hand-edit the signed artifact. Once a live proof begins, resume
or destroy its exact launch receipt before attempting another stack.

Record every live provider observation in the
[Railway live qualification decision ledger](../../../packages/railway-hosting/RAILWAY-EVIDENCE.md#live-qualification-decision-ledger).
Keep failed hypotheses in the ledger as rejected evidence instead of rewriting
history. Each entry must connect the observed provider behavior to the chosen
implementation and a fresh-stack re-test state. Close every disposable attempt
with its receipt-driven cleanup result before beginning another one; never put
credentials, variable values, or secret-bearing URLs in the ledger.

Railway reference variables are context-sensitive, and later variable
inventory is not proof that a resolved reference reached an earlier deployment
snapshot. Live qualification showed both namespaced and unqualified
self-references resolve in inventory while Logto's deployed process still lacks
its admin endpoint. The certified topology therefore uses Railway's documented,
fixed `<service>.railway.internal` DNS name as a non-secret literal for Logto's
own `ADMIN_ENDPOINT`. Genuine cross-service consumers, including the transient
bootstrap, retain `${{service.VARIABLE_NAME}}` references.

## Qualification lifecycle

Release verification does not create Railway resources. Provider authorization
happens when an interactive `host plan` or `host deploy` needs consent. A `--json`
invocation never opens a browser: complete required OAuth consent in a terminal,
then repeat the same command with `--json`.

1. Run `bun apps/cli/scripts/inspect-railway-registry-schema.ts` from the exact
   reviewed source revision. This is a read-only, credential-redacted live
   schema gate for every Railway query, mutation, input, deployment-identity,
   and readiness field used by the driver. If it reports provider contract
   drift, stop; update the contract audit and implementation in a reviewed PR
   before creating a stack.
2. Select the signed stable hosting channel and verify its exact runtime and
   bootstrap images. Historical JSON records in this directory are fixtures,
   not current release approval. A separately supplied qualification bundle
   requires independent source/digest approvals and explicit operator trust;
   see the override contract in `apps/cli/src/lib/railway-release-source.ts`.
3. Run `nautilo host plan --backend railway --workspace <workspace-id>
   --all-providers --json`. The result must identify the expected workspace,
   report the intended verified release, disclose selected/missing
   providers and the dated approximate cost basis, and keep
   `mutationAuthorized` false.
4. Run `nautilo host deploy --backend railway --workspace <workspace-id>
   --all-providers --yes --json` once. Store its launch UUID and Railway project
   ID as operator-sensitive lifecycle metadata. Provider values are projected
   to instance-scoped Railway service variables; they must not appear in the
   JSON output or receipt. Generated database/auth credentials remain in the
   operating-system keychain, not in the receipt.
5. Use `nautilo host inspect --backend railway --launch <launch-id> --json` for
   read-only status. If deployment is pending or interrupted, use `nautilo host
   resume --backend railway --launch <launch-id> --json`. Never rerun `deploy`
   to recover the same attempt.
   A failed JSON result includes a stable, non-secret `failureCode`. Hosted
   Logto handoff codes distinguish authorization rejection, another terminal
   client response, invalid success bytes, and exhausted transient routing.
   Record that code in the decision ledger; never replace it with the provider
   body, bearer, handoff URL, or runtime variables. Fresh-domain `404`, `408`,
   `425`, `429`, and `5xx` responses are retried within the bounded handoff
   window, while `401` and `403` remain terminal.
6. End a disposable proof with `nautilo host destroy --backend railway
   --launch <launch-id> --confirm-project <project-id> --json`. Confirm the
   cleanup receipt is terminal before starting another proof. If provider state
   is uncertain, stop and reconcile the exact receipt; do not delete unrelated
   workspace resources by name. Project deletion is eventually consistent: a
   direct lookup may fail before the consented workspace inventory drops the
   project. Let the bounded destroy verifier converge, or rerun destroy with the
   same receipt; never treat one lookup error as proof of absence.
