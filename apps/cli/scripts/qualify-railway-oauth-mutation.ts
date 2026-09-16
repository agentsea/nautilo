import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { AsyncEntry } from "@napi-rs/keyring";
import { resolveNautiloRootDir } from "@nautilo/config";
import {
  authorizeRailwayOAuth,
  paginateRailwayConnection,
  railwayProjectDelete,
  railwayProjects,
  RAILWAY_OAUTH_CLIENT_ID,
} from "@nautilo/railway-hosting";

import {
  KeyringRailwayOAuthCredentialStore,
  RAILWAY_OAUTH_KEYRING_ACCOUNT,
  RAILWAY_OAUTH_KEYRING_SERVICE,
} from "../src/lib/railway-oauth-credential-store.ts";

const LIVE_CONFIRMATION = "create-and-delete-empty-project";
const workspaceId = process.env["NAUTILO_RAILWAY_QUALIFICATION_WORKSPACE_ID"]?.trim();
if (process.env["NAUTILO_RAILWAY_LIVE_QUALIFICATION"] !== LIVE_CONFIRMATION || !workspaceId) {
  throw new Error("Live Railway OAuth mutation qualification is not explicitly authorized");
}

const store = new KeyringRailwayOAuthCredentialStore(
  new AsyncEntry(RAILWAY_OAUTH_KEYRING_SERVICE, RAILWAY_OAUTH_KEYRING_ACCOUNT),
  join(resolveNautiloRootDir({ env: process.env }), "auth", "railway-oauth.lock"),
);
let graphqlDiagnostic = "unavailable";
const diagnosticFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
  const response = await fetch(input, init);
  if (String(input) === "https://backboard.railway.com/graphql/v2") {
    try {
      const payload = await response.clone().json() as { readonly errors?: readonly { readonly message?: unknown }[] };
      const messages = payload.errors?.flatMap((error) => (
        typeof error.message === "string" ? [error.message.slice(0, 500)] : []
      ));
      if (messages !== undefined && messages.length > 0) graphqlDiagnostic = messages.join(" | ");
    } catch {
      // A diagnostic parse failure does not alter the actual provider response.
    }
  }
  return response;
};
const authorization = await authorizeRailwayOAuth({
  clientId: RAILWAY_OAUTH_CLIENT_ID,
  interactive: false,
  openBrowser: () => Promise.reject(new Error("Qualification never opens a browser")),
  credentialStore: store,
  fetch: diagnosticFetch,
});
if (authorization.outcome !== "authorized") throw new Error("Saved Railway OAuth authorization is unavailable");

const transport = authorization.transport;
const projectName = `nautilo-q-${randomBytes(6).toString("hex")}`;
let projectId: string | undefined;

const inputSchema = await transport.execute({
  name: "RailwayProjectCreateInputSchema",
  document: `query RailwayProjectCreateInputSchema {
    __type(name: "ProjectCreateInput") { inputFields { name } }
  }`,
  isMutation: false,
}, {});
if (inputSchema.outcome !== "success") throw new Error("Railway ProjectCreateInput introspection failed");
const projectCreateInputFields = (inputSchema.data as {
  readonly __type?: { readonly inputFields?: readonly { readonly name?: string }[] } | null;
}).__type?.inputFields?.flatMap((field) => typeof field.name === "string" ? [field.name] : []) ?? [];
process.stdout.write(`Railway ProjectCreateInput fields: ${projectCreateInputFields.sort().join(", ")}\n`);

async function findQualificationProject(): Promise<string | undefined> {
  const result = await paginateRailwayConnection({
    initialVariables: { workspaceId: workspaceId!, includeDeleted: false, first: 50 },
    fetchPage: async (variables) => {
      const page = await transport.execute(railwayProjects, variables);
      return page.outcome === "success" || page.outcome === "partial"
        ? { ...page, data: page.data.projects }
        : page;
    },
  });
  if (result.outcome !== "success") throw new Error("Railway project inventory failed");
  const matches = result.nodes.filter((project) => (
    project.name === projectName && (project.deletedAt === undefined || project.deletedAt === null)
  ));
  if (matches.length > 1) throw new Error("Railway qualification identity is ambiguous");
  return matches[0]?.id;
}

let qualificationSucceeded = false;
let qualificationFailure: unknown;
let qualificationFailureCode = "unknown";
let cleanupFailure: unknown;

async function cleanupQualificationProject(): Promise<void> {
  projectId ??= await findQualificationProject();
  if (projectId !== undefined) {
    const deleted = await transport.execute(railwayProjectDelete, { id: projectId });
    if (deleted.outcome !== "success" || deleted.data.projectDelete !== true) {
      throw new Error("Railway OAuth qualification cleanup failed");
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      // Railway reports an exact deleted-project lookup as a GraphQL error,
      // not `{ project: null }`. Workspace inventory is therefore the
      // authoritative absence proof for this qualification path.
      const observedId = await findQualificationProject();
      if (observedId === undefined) {
        projectId = undefined;
        break;
      }
      await Bun.sleep(500);
    }
  }
  if (projectId !== undefined) throw new Error("Railway OAuth qualification project still exists");
}

try {
  // Qualification deliberately requests only the ID, matching Railway's
  // documented create-project cookbook instead of coupling the proof to
  // optional Project fields used by the production reconciler.
  const created = await transport.execute({
    name: "RailwayQualificationProjectCreate",
    document: `mutation RailwayQualificationProjectCreate($input: ProjectCreateInput!) {
      projectCreate(input: $input) { id }
    }`,
    isMutation: true,
  }, {
    input: { name: projectName, workspaceId },
  });
  if (created.outcome !== "success") {
    qualificationFailureCode = `${created.outcome}:${created.failure.kind}`;
    projectId = await findQualificationProject();
    throw new Error("Railway OAuth project creation did not return a trustworthy success");
  }
  projectId = (created.data as { readonly projectCreate: { readonly id: string } }).projectCreate.id;
  qualificationSucceeded = true;
} catch (error) {
  qualificationFailure = error;
} finally {
  cleanupFailure = await cleanupQualificationProject().then(() => undefined, (error: unknown) => error);
}

if (cleanupFailure !== undefined) throw new Error("Railway OAuth qualification cleanup failed");
if (!qualificationSucceeded || qualificationFailure !== undefined) {
  throw new Error(`Railway OAuth mutation qualification failed (${qualificationFailureCode}: ${graphqlDiagnostic})`);
}
process.stdout.write("Railway OAuth workspace project create/delete qualification passed; cleanup verified.\n");
