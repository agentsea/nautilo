# Railway GraphQL transport evidence

Verified on 2026-08-03, before writing this package. No live mutation was made.

## Official documentation

- [Public API](https://docs.railway.com/integrations/api): the public API is
  GraphQL at `https://backboard.railway.com/graphql/v2`; OAuth is the intended
  bearer-token path for third-party applications; Railway documents schema
  introspection and response rate-limit headers.
- [Manage projects](https://docs.railway.com/integrations/api/manage-projects),
  [services](https://docs.railway.com/integrations/api/manage-services),
  [environments](https://docs.railway.com/integrations/api/manage-environments),
  [variables](https://docs.railway.com/integrations/api/manage-variables),
  [volumes](https://docs.railway.com/integrations/api/manage-volumes),
  [domains](https://docs.railway.com/integrations/api/manage-domains), and
  [deployments](https://docs.railway.com/integrations/api/manage-deployments)
  are the resource-operation references for the pinned document set.

## Native OAuth public-client boundary

Verified against Railway's official OAuth documentation and live discovery on
2026-08-03. The live discovery authority is exactly
`https://backboard.railway.com/oauth/.well-known/openid-configuration` (the
issuer-root `/.well-known/openid-configuration` is not the Railway discovery
document). It reported issuer `https://backboard.railway.com`, authorization
endpoint `https://backboard.railway.com/oauth/auth`, token endpoint
`https://backboard.railway.com/oauth/token`, `none` as a supported token-
endpoint authentication method, and `S256` as the PKCE method. The package pins
and tests those constants so an unrelated discovery authority cannot redirect
the native client.

- [Creating an OAuth app](https://docs.railway.com/integrations/oauth/creating-an-app)
  identifies a CLI as a Native Public application: it has no client secret,
  requires PKCE, uses token-endpoint authentication method `none`, and requires
  exact redirect matching including scheme, host, port, and path. Nautilo
  therefore pins `http://127.0.0.1:43877/callback`; a port collision is a typed
  repair condition and never causes fallback to an unregistered ephemeral port.
- [Login and tokens](https://docs.railway.com/integrations/oauth/login-and-tokens)
  documents the authorization-code flow, the `iss` callback parameter,
  one-hour access-token lifetime, `offline_access` plus `prompt=consent` for
  refresh tokens, refresh-token rotation, and the requirement to retain the
  latest refresh token. Nautilo generates state before binding a listener,
  gives the listener the exact expected state and issuer, and keeps listening
  after malformed or mismatched callbacks. Only a bound code may show callback
  success, and the listener closes before that code is sent to the token
  endpoint. Both code and refresh exchanges carry a bounded abort signal.
- [Scopes and user consent](https://docs.railway.com/integrations/oauth/scopes-and-user-consent)
  documents `openid`, `email`, `profile`, `offline_access`, and
  `workspace:admin`, and explains that workspace scopes present resource
  selection during consent. Memory-only authorization therefore requests
  exactly `openid email profile workspace:admin` with `prompt=consent`: it keeps
  workspace selection explicit but deliberately omits `offline_access` so it
  cannot mint and discard an unretainable refresh token. A durable injected
  credential store adds `offline_access`. Both modes require the returned
  Bearer token to report exactly the conditional requested scope set before a
  GraphQL transport is constructed. Admin is the maximum requested permission;
  it does not elevate a Railway user whose workspace role is lower.
- [Troubleshooting OAuth](https://docs.railway.com/integrations/oauth/troubleshooting)
  shows the native token form (`grant_type`, code, exact redirect, public
  `client_id`, and `code_verifier`, with no secret), warns that reuse of a
  rotated refresh token can revoke the authorization, and requires fresh
  authorization after invalid/expired refresh state. Nautilo holds one
  exclusive credential lease across refresh exchange and atomic replacement,
  preventing two processes from presenting the same rotated token. Clear and
  replace authority belong to that lease and fail closed when it is stale.
- [Authorized apps](https://docs.railway.com/integrations/oauth/authorized-apps)
  documents user revocation in Railway Settings > Apps and immediate token
  invalidation. Nautilo clears the matching stored generation and returns a
  typed reauthorization action; provider response detail is never surfaced.
- [Fetching workspaces or projects](https://docs.railway.com/integrations/oauth/fetching-workspaces-or-projects)
  confirms the workspace query returns only resources selected during consent.

The packaged Node CLI pins
[`@napi-rs/keyring` 1.3.0](https://www.npmjs.com/package/@napi-rs/keyring/v/1.3.0)
for macOS Keychain, Linux Secret Service, and Windows Credential Manager access.
The refresh envelope exists only in that OS store. A separate mode-0600 lock
contains only a format version, PID, and timestamp; it serializes provider
exchange plus atomic rotation across CLI processes and safely reclaims dead or
expired owners. The OAuth package tests refresh concurrency, rotation,
stale-clear protection, revocation, and timeouts. Explicit memory-only mode
omits `offline_access` and rejects an unexpected refresh token. Neither mode
writes a Railway token to config, profiles, receipts, argv, logs, or plaintext
files.

The non-secret public client `rlwy_oaci_m3o2YCnliWf67k5awTIZ7HUW` is registered
as `Nautilo CLI`, Native/Public, with device flow disabled and the exact redirect
above. It is owned by the Nautilo Railway workspace, which is on Pro and has a
second organization administrator. The client ID is the packaged default;
`NAUTILO_RAILWAY_OAUTH_CLIENT_ID` remains only an explicit development/test
override. No client secret exists or is accepted by this native flow.

On 2026-08-04, the packaged CLI completed a live, non-mutating authorization
and plan against the consented `Nautilo` Railway workspace. It resolved that
workspace as payer, confirmed the `nautilo` project name was available, and
returned the expected release and mutation-qualification blockers without
creating or changing any Railway resource. This proves the public client,
fixed loopback callback, token exchange, consent-bounded workspace discovery,
GraphQL transport, provider-reference discovery, and plan renderer together.
A second durable run requested `offline_access`, stored generation one in
macOS Keychain, and completed the same plan. A new noninteractive JSON process
then refreshed and rotated the credential and returned the consented `Nautilo`
workspace without opening a browser. No token value was printed or inspected.

`nautilo host plan --json` and non-TTY runs never bind the loopback server or
open a browser. Interactive authorization requires the explicit browser opener;
missing browser authority, denial, timeout, callback replay, state mismatch,
issuer mixup, insufficient scope, refresh conflict, revocation, and provider or
credential-store failure all return stable redacted categories rather than raw
OAuth payloads.

The Public API page currently documents Hobby limits of 1,000 requests per hour
and 10 requests per second, plus `X-RateLimit-*` and `Retry-After` response
headers. This package only parses those headers; it does not schedule retries.

## Rejected dynamic client registration qualification

Railway's [creating-an-app documentation](https://docs.railway.com/integrations/oauth/creating-an-app)
documents `POST https://backboard.railway.com/oauth/register`, rate limiting,
and a registration access token that is required to manage or delete a dynamic
client. Railway does not document whether an initial access token is required.
[RFC 7591](https://www.rfc-editor.org/rfc/rfc7591.html) makes that token an
authorization-server policy choice and recommends that open registration work
without one; it also defines `token_endpoint_auth_method: "none"` for public
clients. [RFC 7592](https://www.rfc-editor.org/rfc/rfc7592.html) requires the
server-returned registration client URI and registration access token for
management, and specifies HTTP 204 for successful deletion.

The isolated D488 qualification utility makes exactly one anonymous request
for a Native/Public authorization-code client, with the exact pinned loopback
redirect and no client secret. It validates the entire security-relevant
response, accepts only a Railway HTTPS management URI, injects the management
credential into a caller-supplied secure authority, and cleans up immediately
if validation or secure storage fails. Provider bodies and the management token
are never returned. HTTP 401/403, 429, `invalid_client`, timeouts, and cleanup
failures are typed without automatic retry.

One controlled, non-billable live probe on 2026-08-03 returned HTTP 201 without
an Authorization header, proving that Railway currently permits open dynamic
registration without an initial access token. The returned client was a public
client with the exact requested metadata, and deletion at the returned
management URI returned HTTP 204. The credential was then cleared; no Railway
project, service, or other billable resource was created. This proves anonymous
registration and deletion only. It does **not** yet prove that a fresh client
can complete authorization for `workspace:admin`, what consent inventory it
receives, or that the endpoint is reliable enough for every Nautilo install.
Dynamic registration therefore remains a qualification experiment, never a
silent fallback or the D488 V0 production happy path.

## First-party Railway CLI fallback qualification

Railway CLI `5.30.4` remains a recovery/CI fallback candidate, not the packaged
interactive default. Its
[official login documentation](https://docs.railway.com/cli/login) states that
`railway login` opens Railway's browser flow, automatically uses device code on
headless machines, supports new-account creation, and can be invoked by
`railway up`. The corresponding
[official CLI source](https://github.com/railwayapp/cli/blob/abe4605b4542efb2d06d3c77eb7dd11cbe71b3f8/src/oauth.rs)
uses Railway's own Native/Public client, PKCE, and the `workspace:admin` scope;
its [login implementation](https://github.com/railwayapp/cli/blob/abe4605b4542efb2d06d3c77eb7dd11cbe71b3f8/src/commands/login.rs)
owns browser/device-code fallback and refresh persistence. Nautilo can invoke
that first-party binary without registering an OAuth app and without reading,
printing, or asking the user to manufacture an access token. A live read-only
`railway whoami --json` plus authenticated `railway api` workspace query
succeeded with the operator's existing Railway login on 2026-08-03.

The current CLI surface covers the D488 lifecycle closely enough for a typed
subprocess driver:

- `whoami`, `init`, `link`, `status`, project/environment/service inventory,
  and deployment inventory have JSON modes.
- An empty service can be created first; provider values can then be sent one
  at a time through `railway variable set KEY --stdin --skip-deploys --json`,
  whose [official source](https://github.com/railwayapp/cli/blob/abe4605b4542efb2d06d3c77eb7dd11cbe71b3f8/src/commands/variable.rs)
  prints only changed key names; the pinned image can be connected last.
- PostgreSQL, volumes, generated domains, image sources, deployment polling,
  bounded logs, redeploy, and explicit resource/project deletion all have CLI
  commands. `railway api` uses the same first-party session for schema-pinned
  gaps such as deployment rollback and volume backup operations.

This does not remove reconciliation work. Create commands are not universally
idempotent, so Nautilo still needs exact inventory, durable receipts, bounded
subprocesses, version-gated JSON parsers, postcondition checks, and explicit
repair/rollback. Secrets must use stdin; `railway variable list --json` and
bucket credential output contain raw secrets and are prohibited in ordinary
driver output. Railway's Postgres service is unmanaged, so backup schedules,
restore drills, and upgrade ordering remain Nautilo operator responsibilities.

Railway's new TypeScript IaC is not the V0 backbone. The
[official SDK](https://github.com/railwayapp/railway-ts-sdk/tree/f607acaf5680921b9f9b6a279b8c57daf7eeac5f)
labels itself beta, requires the separate `railway` npm package/runner, treats
custom-domain creation as import-only, and explicitly says volume lifecycle is
not a safe V0 authoring path. It is worth re-qualifying later, but today the
smallest coherent driver is typed Railway CLI subprocesses plus narrowly pinned
`railway api` documents for missing verbs.

## Live schema observations

Read-only commands run with Railway CLI `5.30.4`:

```text
railway api search projectCreate
railway api search serviceCreate
railway api search serviceConnect
railway api search volumeCreate
railway api search serviceDomainCreate
railway api search serviceInstanceDeployV2
railway api search variableCollectionUpsert
railway api search serviceInstanceUpdate
railway api search serviceInstance
railway api describe ServiceInstance
railway api describe ServiceSource
railway api search environmentCreate
railway api search project
railway api search serviceDelete
railway api search deployment
railway api search volumeDelete
railway api search serviceDomainDelete
railway api describe Deployment
railway api describe DeploymentListInput
railway api describe DeploymentStatus
railway api describe ServiceCreateInput
railway api describe ServiceConnectInput
railway api describe PageInfo
railway api describe Volume
railway api describe VolumeInstance
railway api describe ProjectServicesConnection
railway api describe ProjectVolumesConnection
railway api describe EnvironmentVolumeInstancesConnection
railway api describe EnvironmentVolumeInstancesConnectionEdge
```

Observed exact schema contracts used here: `projectCreate(input:
ProjectCreateInput!)`, `projectDelete(id: String!)`,
`environmentCreate(input: EnvironmentCreateInput!)`,
`serviceCreate(input: ServiceCreateInput!)`, `ServiceSourceInput.image`,
`serviceConnect(id: String!, input: ServiceConnectInput!)`,
`serviceInstanceUpdate(serviceId: String!, input: ServiceInstanceUpdateInput!,
environmentId: String)`, `variableCollectionUpsert(input:
VariableCollectionUpsertInput!)`, `volumeCreate(input: VolumeCreateInput!)`,
`serviceDomainCreate(input: ServiceDomainCreateInput!)`,
`serviceInstanceDeployV2(serviceId: String!, environmentId: String!,
commitSha: String): String!`, the documented query field names, and the
`edges { cursor node } pageInfo { endCursor hasNextPage }` connection shape.

For the transient bootstrap recovery contract, the same live-schema session
also verified `deployment(id: String!)`, `deployments(input:
DeploymentListInput!, after: String, first: Int!)`, and
`DeploymentListInput.projectId/environmentId/serviceId/includeDeleted`.
`DeploymentStatus` contained exactly `BUILDING`, `CRASHED`, `DEPLOYING`,
`FAILED`, `INITIALIZING`, `NEEDS_APPROVAL`, `QUEUED`, `REMOVED`, `REMOVING`,
`SKIPPED`, `SLEEPING`, `SUCCESS`, and `WAITING`. Railway's
[deployment API reference](https://docs.railway.com/integrations/api/manage-deployments)
documents `SUCCESS` as successful, and `FAILED`, `CRASHED`, `REMOVED`, and
`SKIPPED` as non-success terminal outcomes. The lifecycle coordinator treats
the remaining enum members as pending rather than inventing terminal semantics.

The same live schema confirms that `ServiceCreateInput.source` is optional and
that `ServiceConnectInput.image` accepts a Docker Hub or GHCR image. Railway's
[service API reference](https://docs.railway.com/integrations/api/manage-services)
documents both empty-service creation and later source connection. The
bootstrap sequence can therefore create an empty service, upsert its request-
memory-only variables, and only then connect the signed digest-pinned image;
it must not create the service with its image already attached because Railway
documents deployment upon source-backed service creation.

On 2026-08-04, the same read-only schema inspection confirmed
`serviceInstance(environmentId: String!, serviceId: String!): ServiceInstance!`.
`ServiceInstance` exposes `id`, `serviceId`, `environmentId`, and nullable
`source`; `ServiceSource` exposes `image` and `repo`. The reconcile adapter can
therefore recover a lost `serviceConnect` response by querying the exact
environment/service pair and comparing the immutable image digest. It refuses
to retry when the observed source is empty or different, and it rejects a repo
source rather than treating it as the intended image. No Railway mutation was
made while qualifying this observation path.

`Volume` has `id`, `name`, and `projectId`; it does **not** expose mount or
service attachment fields. Those belong to `VolumeInstance`, which exposes
`id`, `volumeId`, `serviceId`, and `mountPath`. The inventory documents
therefore list project-scoped `Project.volumes` separately from the
environment-scoped `Environment.volumeInstances` connection. Both use the same
verified cursor connection shape. Project service inventory uses the separately
verified `Project.services` connection.

The schema exposes no idempotency-key argument for these mutations in this
check. Retry/receipt semantics therefore belong to the future resource driver,
not this generic transport.

## Provider-contract audit (2026-08-07)

No further full-stack mutation is permitted merely because a focused unit test
passes. Before the next qualification stack, the launch path is checked against
both Railway's current official API guides and the authenticated live schema
exposed by `railway api describe` in Railway CLI 5.30.4. Schema inspection is
read-only and does not print credentials. Where the guide and schema do not
define an observable lifecycle effect, that behavior must be isolated in one
minimal disposable probe, recorded here, and receipt-destroyed before the full
stack is attempted.

The resulting contract matrix is:

| Driver step | Write contract | Canonical observation and recovery contract | Explicit non-contract |
| --- | --- | --- | --- |
| Select workspace | OAuth `workspace:admin` consent and `me.workspaces` | Only consented workspace IDs are eligible | Never infer authority from an account-wide project name |
| Create/adopt project | `projectCreate(input: ProjectCreateInput!): Project!` | Workspace-scoped paginated projects, followed by exact `project(id)` for a receipt ID | Project names are collision detection, not durable identity |
| Create/adopt environment | `environmentCreate`; use `skipInitialDeploys: true` | Project-scoped environments, followed by exact environment ID and its volume-instance scope | Do not assume project creation omitted a default environment |
| Create/adopt service | Empty `serviceCreate`; live `ServiceCreateInput.source` is optional | Project service inventory plus exact service-instance observation in the selected environment | A service name is not an update or destroy identity |
| Attach volume | `volumeCreate` with exact project, environment, service, and mount path | `Project.volumes` proves volume ownership; `Environment.volumeInstances` proves attachment and mount | `Volume` itself does not expose service/mount attachment; list order is meaningless |
| Apply variables | `variableCollectionUpsert(..., skipDeploys: true)` | Boolean mutation acknowledgement and a durable non-secret applied marker; secret values remain request-only | The API has no safe secret-value recovery contract, so an uncertain upsert is retried as the documented idempotent upsert rather than read back |
| Attach image source | `serviceConnect` for public Docker Hub/GHCR images, or `serviceInstanceUpdate` when registry credentials/settings are required | Exact `serviceInstance(serviceId, environmentId).source.image`, compared to the immutable digest. Railway's deployment reference states that a detected source change creates a deployment | `serviceConnect` returns a service, not a deployment ID. A temporarily null `latestDeployment` is not permission to issue a second deploy mutation |
| Generate domain | `serviceDomainCreate` with service, environment, and target port | Exact service/environment domain inventory; adopt only one matching target-port intent | Generated hostnames are provider output and cannot be predicted |
| Recover deployment identity | The fresh-launch path relies on Railway's documented source-change deployment rather than speculatively calling `serviceInstanceDeployV2` | `ServiceInstance.latestDeployment` is nullable and the live schema describes it as “The most recent deployment for this service instance.” Observe it with a bounded wait after source attachment, persist that exact ID, and use `deployment(id)` thereafter | `deployments(...)` is history. Its cardinality and ordering are never current identity. `activeDeployments` is running-only and cannot represent a completed one-shot. Day-two variable-only redeploys require their own explicit contract |
| Determine readiness | None | Query the exact receipt-owned deployment ID. Long-lived services require the expected running instance state; one-shots require stopped deployment with cleanly exited instances | `SUCCESS` alone does not distinguish a running service from a completed job |
| Destroy | Domain, service, volume, then project deletes by exact receipt IDs | Bounded exact-ID/project-scope absence verification, including provider eventual consistency | A successful delete acknowledgement is not immediate inventory absence |

Primary documentation:

- <https://docs.railway.com/integrations/api>
- <https://docs.railway.com/integrations/api/manage-services>
- <https://docs.railway.com/integrations/api/manage-deployments>
- <https://docs.railway.com/integrations/api/manage-variables>
- <https://docs.railway.com/integrations/api/manage-volumes>
- <https://docs.railway.com/integrations/api/manage-domains>
- <https://docs.railway.com/guides/docker-compose>

Railway also introduced a beta project-level TypeScript IaC system in CLI
5.30.4. It can describe services, managed databases, volumes, variables, and
custom domains, and its plan/apply engine includes stale-plan and destructive-
apply protections. It is not the V0 BYOC execution engine because it requires a
Railway CLI login plus a linked pre-existing project/environment, generated
Railway domains are outside its file, secret literals would have to enter its
evaluation boundary, and Railway explicitly labels the feature beta with
conservative/unfinished volume lifecycle behavior. It is worth a separate
internal-cloud or later driver spike; it is not a reason to mix two owners into
the current receipt-backed OAuth/GraphQL launch.

- <https://docs.railway.com/infrastructure-as-code>
- <https://docs.railway.com/infrastructure-as-code/reference>

## Read-only planning and cost boundary

Railway's current OAuth documentation for
[fetching workspaces](https://docs.railway.com/integrations/oauth/fetching-workspaces-or-projects)
states that `me { workspaces { id name } }` returns only the workspaces selected
by the user during consent. The planning slice uses that pinned query plus the
live-schema-verified paginated `projects(workspaceId: ...)` query. It does not
invoke the CLI and rejects any operation marked as a GraphQL mutation in tests.

Railway's [pricing documentation](https://docs.railway.com/pricing/plans)
publishes subscription and resource rate cards, not a Nautilo-topology monthly
estimate API. The 2026-08-03 pinned estimator uses the published rates of $10
per GB-RAM-month, $20 per vCPU-month, $0.15 per GB-volume-month, and $0.05 per
GB egress. It requires explicit CPU, memory, volume, egress, and monthly-active-
hour assumptions for each final service, emits a per-service rounded-cent
breakdown, and applies Hobby's documented $5 minimum/included-usage context to
the resulting resource estimate. A separately measured Nautilo workload may
supply a timestamped USD resource-usage range; the planner applies the same
Hobby floor transparently. It never infers a plan tier or usage from workspace
inventory. An absent, malformed, or incomplete disclosure is shown as a
nonblocking limitation (`not-yet-measured` where no valid estimate exists),
because cost uncertainty must be visible but does not prevent a technical user
from deploying. Railway's documented dashboard cost controls remain an operator
action and are not fabricated as a GraphQL planning capability.

## V1 topology facts used by the pure builder

- [Manage services](https://docs.railway.com/integrations/api/manage-services)
  documents service creation and image sources. The topology contains five
  final service intents (`app-postgres`, `logto-postgres`, `logto-seed`,
  `logto`, and `nautilo-server`) and a separately-modelled temporary bootstrap
  service. It does not model Compose `depends_on`; Railway's service primitive
  has no Compose dependency contract in this API reference.
- [Manage volumes](https://docs.railway.com/integrations/api/manage-volumes)
  and the live `VolumeCreateInput` inspection show the driver must attach a
  volume by project/service/environment/mount/region rather than promise a
  user-selected provider volume name. The three local logical mount names are
  therefore not provider names.
- [Manage domains](https://docs.railway.com/integrations/api/manage-domains)
  documents generated domains with a service target port. V1 requests only
  Nautilo `3001` and Logto `4301`; the `4302` Logto admin port remains private.
- [Manage variables](https://docs.railway.com/integrations/api/manage-variables)
  documents Railway service references in `${{Service.VARIABLE}}` form. The
  builder retains `RAILWAY_PRIVATE_DOMAIN` references structurally, including
  mixed text/reference values documented by Railway.

The desired `NAUTILO_HOST=::` Railway private-network bind and the conversion
of the local Logto post-seed bootstrap into a Railway-safe idempotent handoff
are now encoded in the topology/workflow. End-to-end release-image runtime
qualification remains separate from these provider API and variable facts.

The long-lived Postgres services retain only their own `POSTGRES_USER` and
`POSTGRES_PASSWORD` bootstrap identity. The replacement for
`infra/postgres-init.sh` is the transient TypeScript reconciler, so Nautilo,
agent, crypto, and Logto role passwords are inputs to that job and to their
actual runtime consumers—not variables on an unrelated database service. The
database-admin restriction is consequently about long-lived application
services (Nautilo and Logto): each database service necessarily has its own
admin bootstrap credential.
# Runtime variable and private-network qualification (2026-08-04)

Railway's official Variables Reference documents that template values may combine additional text and multiple variables. The official API guide documents writing reference-variable syntax through `variableCollectionUpsert`, and the private-networking guide gives `BACKEND_URL=http://${{api.RAILWAY_PRIVATE_DOMAIN}}:${{api.PORT}}` as an embedded-reference example. The runtime projection therefore preserves Railway references inside connection strings sent to the API instead of blocking those composites.

Railway's private-networking guide recommends binding Node services to `::` for both current dual-stack and legacy IPv6-only environments. Nautilo passes `NAUTILO_HOST` through its canonical instance resolver to `app.listen({ port, host })`, so `NAUTILO_HOST=::` is the documented provider-compatible bind rather than a deployment blocker.

- <https://docs.railway.com/variables/reference>
- <https://docs.railway.com/integrations/api/manage-variables>
- <https://docs.railway.com/private-networking>

## Native OAuth mutation qualification (2026-08-04)

Railway's official OAuth scope guide says `workspace:admin` maps to admin access
for user-selected workspaces, and its API project guide documents creating and
deleting an empty project with `projectCreate` and `projectDelete`.

The saved Nautilo CLI native/public OAuth grant exposed exactly one consented
workspace, `Nautilo`. The guarded qualification script introspected the live
`ProjectCreateInput`, created one uniquely named empty project in that exact
workspace, deleted it immediately by returned ID, and verified absence through
the workspace's paginated project inventory. The final qualification passed.
No service, volume, domain, deployment, or variable was created.

Two live provider semantics are now regression requirements:

- Railway rejected an overlong qualification project name as `Invalid project
  name`; failed creates also consumed the workspace's one-project-per-30-second
  create throttle. The production project name `nautilo` is within the proven
  accepted shape, and retry handling must not blindly repeat GraphQL errors.
- An exact lookup for a deleted project returns a GraphQL error rather than
  `{ project: null }`. Project deletion/absence verification must therefore use
  the consented workspace inventory, not interpret an arbitrary GraphQL error
  as proof of absence.

- <https://docs.railway.com/integrations/oauth/scopes-and-user-consent>
- <https://docs.railway.com/integrations/api/manage-projects>

## Private image qualification seam (2026-08-04)

Railway's current private-registry guide explicitly supports GHCR and says
private-registry credentials are a Pro feature, encrypted at rest with envelope
encryption, and decrypted only while Railway pulls the image. GHCR uses a
GitHub classic PAT with `read:packages` in the documented dashboard flow.

Read-only introspection through the saved Nautilo native OAuth grant confirms
the same facility exists in the public GraphQL schema rather than only in the
dashboard:

- `RegistryCredentialsInput` requires `username` and `password` strings;
- `ServiceCreateInput.registryCredentials` accepts that input; and
- `ServiceInstanceUpdateInput.registryCredentials` accepts that input alongside
  the service-instance source.

`ServiceConnectInput` itself contains only `branch`, `image`, and `repo`, so a
driver which creates an empty service and later connects its image cannot
invent a credential field on `serviceConnect`. Qualification must either create
the source and registry credentials together or apply both through
`serviceInstanceUpdate` before deployment.

This is an operator-only qualification escape hatch for the currently private
Nautilo GHCR packages. It does **not** alter the production release contract:
public Nautilo releases must use public, immutable digest references and must
not require a Nautilo/private GHCR pull token. Making those packages public
remains gated on the separately tracked repository/package history, secret,
PII, and release-content audit.

- <https://docs.railway.com/builds/private-registries>
- <https://docs.railway.com/services#deploying-a-private-docker-image>

## Start-command, runtime-readiness, and teardown qualification (2026-08-06)

The first full qualification deployment exposed three provider semantics that
are now part of the driver contract:

- Railway's image start-command setting replaces the image `ENTRYPOINT` in
  exec form. The `logto-seed` service therefore uses Logto's documented
  `npm run cli db seed -- --swe` command explicitly; attaching the Logto image
  alone runs its ordinary server command and does not seed the database.
- A GraphQL deployment `status` of `SUCCESS` is not sufficient proof that a
  long-lived process remains alive. Live schema inspection confirms
  `Deployment.deploymentStopped` and `Deployment.instances { id status }`.
  Long-lived readiness now requires a running instance, while the one-shot
  seed and database bootstrap require a stopped deployment whose instances
  exited cleanly. Hosted handoff bootstrap instead requires a running instance
  before its authenticated HTTPS output is fetched.
- A volume attached to a service cannot be deleted first. Receipt teardown is
  ordered generated domain, service, volume, then project. Exact transient
  bootstrap service/domain IDs from their lifecycle checkpoint are merged into
  cleanup inventory so an interrupted handoff cannot become an unowned
  survivor.
- Railway volume roots may contain provider-created filesystem entries such as
  `lost+found`. Both Postgres services keep the documented volume mount at
  `/var/lib/postgresql/data` but set `PGDATA` to the child directory
  `/var/lib/postgresql/data/pgdata`, matching Railway's own Postgres service
  configuration and avoiding `initdb` refusal at a non-empty mount root.
- Railway may retain soft-deleted projects, pending/deleted volume instances,
  and `REMOVED` deployments in list results even when the corresponding
  `includeDeleted` argument is false. The adapter requests exclusion and also
  filters those explicit provider tombstone states before collision,
  reconciliation, recovery, or absence decisions.

- <https://docs.railway.com/deployments/start-command>
- <https://docs.railway.com/deployments/reference>
- <https://docs.railway.com/integrations/api/manage-deployments>
- <https://docs.railway.com/integrations/api/manage-volumes>
- <https://docs.logto.io/logto-oss/using-cli>
- <https://github.com/logto-io/logto/blob/v1.38.0/docker-compose.yml>

## Live qualification decision ledger

This ledger records provider observations and the resulting decisions without
retaining credentials, variable values, or secret-bearing URLs. A decision is
not considered qualified until its re-test column is satisfied on a fresh
single-stack deployment. Entries are append-only in substance: preserve a
failed hypothesis as rejected evidence, record the replacement decision, and
close each disposable attempt with receipt-driven teardown evidence before a
new stack is created.

| ID | Live evidence | Decision and implementation | Re-test state |
| --- | --- | --- | --- |
| RQ-001 | Railway rejected an overlong qualification project name and charged the failed request against its project-create throttle. | Keep the production project name bounded (`nautilo`) and never blindly retry semantic GraphQL failures. | Qualified by the subsequent create/delete OAuth mutation run. |
| RQ-002 | The first full stack ran the Logto image's ordinary server process instead of seeding when no provider start command was configured. | Model and reconcile `startCommand`; set `logto-seed` to Logto's documented `npm run cli db seed -- --swe`. | Qualified on deployment `9e093b6b-f42e-44a5-bd5e-3b5cce673a0a`: seed logged table/config/proxy-app creation and exited successfully. |
| RQ-003 | Postgres `initdb` rejected Railway's non-empty volume root containing provider-created `lost+found`. | Keep the volume mount at `/var/lib/postgresql/data` and set both database services' `PGDATA=/var/lib/postgresql/data/pgdata`. | Qualified on project `97041dd8-3c8c-4589-b403-47cf0a2ff9d6`: both databases remained `RUNNING`. |
| RQ-004 | Railway inventories returned deleted projects, pending/deleted volume instances, and removed deployments despite exclusion flags; volume-first deletion also failed while attached. | Defensively filter explicit tombstones and destroy in domain, service, volume, project order with bounded absence checks. | Qualified by complete driver teardown of the preceding failed stack with zero resources remaining. |
| RQ-005 | Hosted bootstrap deployment `4b21bbc6-1b0b-4576-acc3-d8c3bfcab43c` reached Logto discovery and PostgreSQL, but Logto returned `oidc.invalid_client` for seeded `m-admin`. Seed logs proved the client was created. The first hypothesis was a mismatch between loopback `ADMIN_ENDPOINT` and Railway's private hostname. | Configure Logto's canonical `ADMIN_ENDPOINT` as `http://${{logto.RAILWAY_PRIVATE_DOMAIN}}:4302`, matching its real cross-service origin without exposing port 4302 publicly. This is correct Logto configuration but is **not** the token failure's root cause. | Rejected as root cause: fresh deployment `9e5b705b-228e-4f11-a65b-e61d54e145e5` had the expected private origin and failed identically. |
| RQ-006 | Railway marks a one-shot successful deployment as stopped with all instances `EXITED`, while long-lived services report a non-stopped deployment with a `RUNNING` instance. Deployment `SUCCESS` alone did not distinguish them. | Read `deploymentStopped` and instance status. Require clean `EXITED` state for one-shots and a current `RUNNING` instance for long-lived/handoff services. | Qualified end to end by fresh launch `9aea6b7a-7ce8-4cb6-93a9-aa40c179bd78`: both bootstrap phases completed, final long-lived services reconciled, and the receipt reached `claimable`. |
| RQ-007 | Fresh launch `dd878ce6-a979-4311-a15b-4c07c1d36d69` returned top-level `failure` at provisioning after the database-bootstrap deployment start response was uncertain, while live inventory showed both databases running and the exact one-shot bootstrap deployment successfully exited. Its receipt safely retained the service ID and variables-applied marker. | Resume only from the durable receipt and recover the uniquely matching deployment; never issue a duplicate create. Report a safely resumable, marker-backed provider uncertainty as pending rather than an undifferentiated failed stack. | Recovery qualified on the same launch for both bootstrap start-response boundaries without duplicate services; exact classifier regressions added. |
| RQ-008 | Logto v1.38 source sets confidential Web and M2M applications to `token_endpoint_auth_method=client_secret_basic`. Its official Management API example likewise uses HTTP Basic. Nautilo instead sent `client_id` and `client_secret` in the form body (`client_secret_post`), which v1.38 rejected as `invalid_client` even though the database credential probe succeeded. | Send the M2M client identity in an `Authorization: Basic` header and omit both credentials from the form body. Keep the existing bounded retry/redaction behavior. | Qualified together with the final routing correction in RQ-013: both token requests returned HTTP 200 and Logto reconciliation completed. |
| RQ-009 | Main workflow run `31115812966` built source `aed839ab8245ad47c15fd5540ea0d68d30dadbd0`, passed the exact-image and native safe-failure gates on amd64 and arm64, published manifest `sha256:3bf5671f9c34d0398ec46b456cd349cde3a198fa1d906a63be5b2bb0261e96d6`, and anonymously pulled and executed both platform images. | Replace the prior bootstrap record and independent assembly approvals together; never point qualification at a mutable tag or an unreviewed local build. | Image publication qualified; fresh Railway execution remains part of RQ-008. |
| RQ-010 | Fresh signed-release launch `7be96868-89eb-4bfb-b8f9-c51ae1477b7d` proved the Basic-auth implementation from RQ-008 was present, yet Logto again rejected `m-admin`. Logto's own runtime log classified every private-port discovery/token request as tenant `default` and advertised only its loopback admin URL. Railway exposed the configured `ADMIN_ENDPOINT` value after deployment, but the topology had rendered the Logto service's reference to its own `RAILWAY_PRIVATE_DOMAIN` with the cross-service form (`${{logto.RAILWAY_PRIVATE_DOMAIN}}`). Railway documents a distinct unqualified form for a variable in the same service (`${{ VARIABLE_NAME }}`). | RQ-008 was necessary but incomplete, and RQ-005's namespaced self-reference is rejected. Add an explicit current-service reference type and render Logto's `ADMIN_ENDPOINT` as `http://${{ RAILWAY_PRIVATE_DOMAIN }}:4302`; retain the namespaced `logto` reference only in other services such as the transient bootstrap. Add projection/topology regressions and requalify from a fresh single stack. | Root cause proved from exact Logto v1.38 source, live tenant logs, resolved Railway configuration, and current Railway variable-reference docs. Structural implementation, focused regressions, and repository typecheck pass; fresh-stack qualification remains pending. The failed stack was receipt-destroyed and independently verified absent before implementation continued. |
| RQ-011 | Receipt destroy for launch `7be96868-89eb-4bfb-b8f9-c51ae1477b7d` deleted the project, and direct service lookup immediately returned `Project not found`, but the first workspace inventory still contained the project and made the command report cleanup failure. The next independent workspace inventory returned zero matches. | Treat project deletion as eventually consistent and give the exact-ID absence verifier a bounded retry window. Never reinterpret one GraphQL lookup error as absence and never create another stack until consented workspace inventory reaches zero. | Qualified by launch `4342255e-6cb0-4417-8471-06b8520800f4`: the one-minute verifier returned terminal `complete`, cleanup `verified`, and zero remaining resources in one receipt-driven command. |
| RQ-012 | Fresh signed-release launch `4342255e-6cb0-4417-8471-06b8520800f4` used the RQ-010 same-service form. Railway's variable inventory resolved `ADMIN_ENDPOINT` to `http://logto.railway.internal:4302`, but the exact deployed Logto 1.38 process again advertised only `http://localhost:4302/` and classified every private-port request as tenant `default`. The transient bootstrap therefore failed at the same `m-admin` boundary. | Reject RQ-010's reference-form change as sufficient. Because the certified topology owns the fixed service name `logto` and Railway documents its internal DNS as `<service>.railway.internal`, make Logto's own `ADMIN_ENDPOINT` the non-secret safe literal `http://logto.railway.internal:4302`. Keep reference variables for genuine cross-service consumers. Remove the unused current-service reference mechanism rather than carrying speculative abstraction. | Qualified by RQ-013: Logto advertised the literal private endpoint, selected the admin tenant, and served both token requests successfully. The earlier failed launch was receipt-destroyed with terminal verified cleanup and zero remaining resources. |
| RQ-013 | Fresh signed-release launch `d22f6839-8221-4412-a4d2-167a8f7025d7` used the RQ-012 literal. Logto advertised both localhost and `http://logto.railway.internal:4302/`, initialized the `admin` tenant, and returned HTTP 200 for both bootstrap token requests. The hosted bootstrap then completed Logto reconciliation and served the exact eight-key handoff. An independent authenticated request using the same keychain-held credential returned HTTP 200 and the exact output schema without exposing values. Driver resume nevertheless stopped at `handoff-fetch/executor-failure` before final projection or reconciliation. | Qualify the literal internal-DNS fix and retire `invalid_client` as the active failure. Treat the remaining defect as the driver's hosted handoff fetch path. Preserve opaque public failure output, but add deterministic safe stage/code diagnostics and tests around the concrete HTTP boundary before another live run; do not weaken bearer validation or persist handoff values. | Logto admin routing, M2M authentication, reconciliation, and hosted output are qualified. Driver fetch diagnosis and fresh end-to-end re-test remain pending. The launch was receipt-destroyed after one exact-receipt resume: cleanup is terminal `verified` with zero remaining resources. |
| RQ-014 | Signed-release launch `a029db4b-e02c-4198-89f2-c6a093becf04` returned the new safe code `railway.bootstrap.handoff-fetch.executor-failure`, excluding every classified HTTP result and proving the concrete request was never completed. The lifecycle copied the class method to a local variable and called it without its receiver; `RailwayGraphqlBootstrapExecutor.fetchHandoff` reads private instance fields, so JavaScript throws before `fetch`. Unit lifecycle mocks used receiver-independent arrow functions and did not exercise this boundary. | Invoke `fetchHandoff` through `request.executor` so its receiver is preserved. Add a lifecycle regression using the concrete executor with an injected successful fetch, not another arrow-function substitute. Keep the safe HTTP classifications and bounded fresh-domain retries from RQ-013. | Qualified by launch `d29533ca-2088-4b39-96f2-f72636a46134`: authenticated hosted handoff fetch completed and execution advanced into final handoff application. |
| RQ-015 | Fresh signed-release launch `eccd2bdb-19d6-48cb-9856-2ba9c13a2d22` stopped at `railway.reconcile.deployment.ambiguous-resource` after adopting the sole `app-postgres` deployment but before recording `logto-postgres`. The adapter inventories non-deleted deployment history, while reconciliation assumes exactly zero or one deployment per service. A fresh Railway service can already have multiple non-deleted deployment records, so history cardinality is not current-runtime identity. | Do not sort or guess from deployment history. Railway's current guide and authenticated live schema expose `ServiceInstance.latestDeployment`; reconcile the receipt to that exact ID and preserve history listing only where lifecycle history is actually required. | Qualified through the prior failing boundary by launch `d29533ca-2088-4b39-96f2-f72636a46134`: both databases, the seed, Logto, and their exact current deployments were reconciled without consulting history cardinality. |
| RQ-016 | Signed-release launch `d29533ca-2088-4b39-96f2-f72636a46134` completed both bootstrap jobs and the authenticated eight-field handoff, applied final variables and the exact Nautilo runtime digest, then stopped at `railway.bootstrap.handoff-apply.executor-failure` before recording the Nautilo deployment. Read-only live inspection shortly afterward showed the exact runtime source and a successful latest deployment. Railway's deployment reference states that a detected service-source change creates a deployment; live schema says `serviceConnect` returns `Service!`, `ServiceInstance.latestDeployment` is nullable, and `serviceInstanceDeployV2` separately creates and returns a deployment ID. | Reject the previous null-means-create behavior in both persistent-service and transient-bootstrap paths. Use `variableCollectionUpsert(skipDeploys: true)`, connect the source once, then boundedly observe Railway's provider-created `latestDeployment`. Persist its exact ID and query only `deployment(id)` for readiness. If it remains absent, fail without issuing a speculative second deployment or consulting deployment-history cardinality. | Qualified by fresh launch `9aea6b7a-7ce8-4cb6-93a9-aa40c179bd78`: final variable projection, immutable runtime source connection, provider-created deployment observation, and readiness all completed without a speculative deployment mutation. |
| RQ-017 | The first destroy pass entered cleanup; the second deleted the exact receipt-owned project but returned failure while reconciling already-removed subordinate receipt artifacts. The persisted receipt nevertheless reached terminal `verified`, zero resources, and Railway returned `Project not found` for the exact project ID. A third CLI invocation then rejected confirmation because the verified receipt correctly no longer contained a project resource. | Preserve project deletion as the authoritative aggregate teardown boundary, make the command return its persisted terminal verified result when provider deletion succeeded, and keep subordinate cleanup bookkeeping from converting verified zero-provider-state into a false failure. | Qualified by the single receipt-driven destroy of fresh launch `9aea6b7a-7ce8-4cb6-93a9-aa40c179bd78`: the command returned `complete`, cleanup `verified`, and zero remaining resources. |
| RQ-018 | Fresh launch `ef7be9bb-69b4-4ce3-b4fb-eba8fb177381` attached the `logto-seed` image and start command through `serviceInstanceUpdate`, but Railway never created a deployment; deploy and one exact-receipt resume both stopped at `railway.reconcile.deployment.executor-failure`. Railway's service API documents `serviceInstanceUpdate` as the build/deploy-settings mutation and `serviceConnect` as the separate source-connection mutation. | Configure `startCommand` first with `serviceInstanceUpdate`, then attach the immutable public image exactly once through `serviceConnect`. Never send source or registry authority through the settings mutation. | Qualified by fresh launch `3ff1d6f5-a7b0-4fe9-8fc1-4366edfbb2b5`: the seed deployment was created and completed, both bootstraps and final reconciliation completed, and the receipt reached `claimable`. The failed launch and the qualifying launch were each receipt-destroyed to terminal `verified` with zero remaining resources. |
| RQ-019 | The qualifying launch had both `logto-public` and `nautilo-public` domain receipts. `host inspect` selected the first domain by kind, exposed Logto's URL as Nautilo, and accepted Logto's health response as runtime readiness. | Select only the canonical `nautilo-public` logical receipt for URL output and the `/health/ready` probe; fail closed if that exact receipt is absent. | Qualified by fresh launch `9aea6b7a-7ce8-4cb6-93a9-aa40c179bd78`: with both domain receipts present, read-only inspection selected the exact Nautilo URL and returned `runtimeReady: true` only after its `/health/ready` probe succeeded. |
| RQ-020 | Corrected inspection found Railway's Nautilo deployment `RUNNING` while its public health request timed out. Redacted runtime logs showed the exact published D490 source `bfd95041124aeaac827165dfe062a85c6e1b1fea` aborting cloud boot because its older guard accepted only OpenAI, Anthropic, or Google, even though the launch projected OpenRouter. Main already contains the capability-based guard from `88fee01a7` that accepts supported chat providers including OpenRouter. Canonical workflow run `31169086882` published source `dd2c8a1d2883b6c5afb4fbf0bc105ef017a78052` as public multi-architecture digest `sha256:61bdacb3180cfc4e524422c49b1962fc880645e808e18b6ffa6622ac65785320`; its retained artifact record was regenerated byte-for-byte and anonymously inspected for AMD64 and ARM64. | Replace the stale D490 handoff and independent approval constants together, assemble a fresh signed five-image qualification bundle, and re-run from a fresh stack. Do not work around the stale image by fabricating an OpenAI key or weakening the current capability guard. | Qualified from merged `main` by assembly run `31198695829` and fresh launch `9aea6b7a-7ce8-4cb6-93a9-aa40c179bd78`. The signed five-image bundle verified as `qualification-31198695829-1`; the launch reached `claimable`; exact `nautilo-public` inspection returned `runtimeReady: true` with OpenRouter-backed chat/embeddings plus configured search, TTS, and STT; receipt-driven teardown completed with cleanup `verified` and zero remaining resources. |
| RQ-021 | The first remote owner-claim installation used the exact Keychain-held bootstrap token; independent comparison proved it matched the Railway service variable and deployment snapshot, yet the target returned HTTP 403 while public status remained `awaiting-owner`. The server's bootstrap gate treated the seeded owner row as proof that a Human owner had completed setup. | Do not infer owner binding from seed identity. Gate remote bootstrap authority on explicit canonical owner-bound state while preserving the narrow loopback operator path. Add fresh-database coverage where the seed row exists but Human password/PIN/profile completion does not. | Fixed by PR #797. Canonical workflow run `31213945839` passed both platforms and published runtime manifest `sha256:ae2cf3d8108e85ff33cb76753c26f01792fb34dffc3b14e72facd6f4c9745852`; PR #798 pinned its byte-verified record and assembly run `31215609472` produced `qualification-31215609472-1`. The next stack passed this authorization boundary and exposed RQ-022. |
| RQ-022 | Fresh launch `d8a15371-f9f4-4c26-aa9f-eb33ea498674` reached `claimable` and exact Nautilo `runtimeReady: true`. Exact resume attempted owner-claim installation, but the CLI serialized `{schemaVersion:1,claimHash,expiresAt}` while the strict Fastify body schema accepted only `{claimHash,expiresAt}`. The target returned HTTP 400 and stayed `awaiting-owner`; the CLI collapsed the rejection into an unknown write and nevertheless presented local `claim-active`. Separate unit mocks had encoded both halves without crossing the actual wire boundary. | Freeze one shared/round-tripped V1 schema, test the real CLI serializer through the real Fastify route and database projection, and preserve typed HTTP/auth/contract/timeout/ambiguity failures. Never report a target owner state unless the target returned and validated it. Stop image builds, release assembly, and live stacks until the no-Railway contract and owner vertical pass. | Open. The failed stack was receipt-destroyed with terminal cleanup `verified` at `2026-08-07T20:31:49.474Z`; zero resources remained, and the following read-only plan observed zero workspace projects. |

RQ-005 is grounded in Logto's configuration reference, which defines
`ADMIN_ENDPOINT` as the Admin Console URL and states that it determines the
allowed admin origin. The private Railway URL is therefore configuration, not
an extra public admin domain.

- <https://docs.logto.io/concepts/core-service/configuration>
- <https://docs.logto.io/logto-oss/troubleshooting-oss>
- <https://docs.logto.io/integrate-logto/interact-with-management-api>
- <https://github.com/logto-io/logto/blob/v1.38.0/packages/core/src/oidc/utils.ts>
- <https://docs.railway.com/variables>
- <https://docs.railway.com/integrations/api/manage-variables>
