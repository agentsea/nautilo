import { join } from "node:path";

import { AsyncEntry } from "@napi-rs/keyring";
import { resolveNautiloRootDir } from "@nautilo/config";
import {
  authorizeRailwayOAuth,
  RAILWAY_OAUTH_CLIENT_ID,
} from "@nautilo/railway-hosting";

import {
  KeyringRailwayOAuthCredentialStore,
  RAILWAY_OAUTH_KEYRING_ACCOUNT,
  RAILWAY_OAUTH_KEYRING_SERVICE,
} from "../src/lib/railway-oauth-credential-store.ts";

const store = new KeyringRailwayOAuthCredentialStore(
  new AsyncEntry(RAILWAY_OAUTH_KEYRING_SERVICE, RAILWAY_OAUTH_KEYRING_ACCOUNT),
  join(resolveNautiloRootDir({ env: process.env }), "auth", "railway-oauth.lock"),
);
const authorization = await authorizeRailwayOAuth({
  clientId: RAILWAY_OAUTH_CLIENT_ID,
  interactive: false,
  openBrowser: () => Promise.reject(new Error("Schema inspection never opens a browser")),
  credentialStore: store,
});
if (authorization.outcome !== "authorized") {
  throw new Error("Saved Railway OAuth authorization is unavailable");
}

const result = await authorization.transport.execute({
  name: "RailwayRegistrySchema",
  document: `query RailwayRegistrySchema {
    __schema {
      types {
        kind
        name
        inputFields {
          name
          type { kind name ofType { kind name ofType { kind name } } }
        }
        fields {
          name
          args {
            name
            type { kind name ofType { kind name ofType { kind name } } }
          }
        }
      }
    }
  }`,
  isMutation: false,
}, {});
if (result.outcome !== "success") throw new Error("Railway schema inspection failed");

type TypeRef = {
  readonly kind?: string;
  readonly name?: string | null;
  readonly ofType?: TypeRef | null;
};
type SchemaMember = { readonly name?: string; readonly type?: TypeRef };
type SchemaType = {
  readonly kind?: string;
  readonly name?: string;
  readonly inputFields?: readonly SchemaMember[] | null;
  readonly fields?: readonly (SchemaMember & { readonly args?: readonly SchemaMember[] })[] | null;
};
const types = (result.data as { readonly __schema?: { readonly types?: readonly SchemaType[] } }).__schema?.types ?? [];
const exactTypes = new Set([
  "Deployment",
  "DeploymentListInput",
  "EnvironmentCreateInput",
  "ProjectCreateInput",
  "RegistryCredentialsInput",
  "Service",
  "ServiceConnectInput",
  "ServiceCreateInput",
  "ServiceDomainCreateInput",
  "ServiceInstance",
  "ServiceInstanceUpdateInput",
  "Template",
  "VariableCollectionUpsertInput",
  "VolumeCreateInput",
]);
const rootFields = new Set([
  "deployment",
  "deployments",
  "domains",
  "environment",
  "environments",
  "project",
  "projects",
  "serviceInstance",
  "templateSourceForProject",
  "variables",
  "environmentCreate",
  "projectCreate",
  "projectDelete",
  "serviceConnect",
  "serviceCreate",
  "serviceDelete",
  "serviceDomainCreate",
  "serviceDomainDelete",
  "serviceInstanceDeployV2",
  "serviceInstanceUpdate",
  "variableCollectionUpsert",
  "volumeCreate",
  "volumeDelete",
]);
const relevant = types.flatMap((type) => {
  if (type.name === "Mutation" || type.name === "Query") {
    return [{
      ...type,
      fields: (type.fields ?? []).filter((field) => rootFields.has(field.name ?? "")),
    }];
  }
  return exactTypes.has(type.name ?? "") ? [type] : [];
});

const requireNames = (
  typeName: string,
  member: "fields" | "inputFields",
  expected: readonly string[],
): void => {
  const type = relevant.find((candidate) => candidate.name === typeName);
  const names = new Set((type?.[member] ?? []).flatMap((entry) => (
    typeof entry.name === "string" ? [entry.name] : []
  )));
  const missing = expected.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(`Railway provider contract drift: ${typeName}.${member} missing ${missing.join(", ")}`);
  }
};

const requireArgs = (typeName: "Query" | "Mutation", fieldName: string, expected: readonly string[]): void => {
  const type = relevant.find((candidate) => candidate.name === typeName);
  const field = (type?.fields ?? []).find((candidate) => candidate.name === fieldName);
  const names = new Set((field?.args ?? []).flatMap((entry) => (
    typeof entry.name === "string" ? [entry.name] : []
  )));
  const missing = expected.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(`Railway provider contract drift: ${typeName}.${fieldName} missing arguments ${missing.join(", ")}`);
  }
};

requireNames("Query", "fields", [
  "deployment", "deployments", "domains", "environment", "environments",
  "project", "projects", "serviceInstance", "templateSourceForProject", "variables",
]);
requireNames("Mutation", "fields", [
  "environmentCreate", "projectCreate", "projectDelete", "serviceConnect",
  "serviceCreate", "serviceDelete", "serviceDomainCreate", "serviceDomainDelete",
  "serviceInstanceDeployV2", "serviceInstanceUpdate", "variableCollectionUpsert",
  "volumeCreate", "volumeDelete",
]);
requireNames("ServiceInstance", "fields", [
  "activeDeployments", "environmentId", "id", "latestDeployment", "serviceId",
  "source", "startCommand",
]);
requireNames("Service", "fields", ["templateId", "templateServiceId", "templateThreadSlug"]);
requireNames("Template", "fields", ["communityThreadSlug", "id"]);
requireNames("Deployment", "fields", [
  "deploymentStopped", "id", "instances", "status",
]);
requireNames("ProjectCreateInput", "inputFields", ["defaultEnvironmentName", "name", "workspaceId"]);
requireNames("EnvironmentCreateInput", "inputFields", ["name", "projectId", "skipInitialDeploys"]);
requireNames("ServiceCreateInput", "inputFields", ["environmentId", "name", "projectId", "source"]);
requireNames("ServiceConnectInput", "inputFields", ["image"]);
requireNames("ServiceInstanceUpdateInput", "inputFields", [
  "healthcheckPath", "healthcheckTimeout", "region", "registryCredentials", "source", "startCommand",
]);
requireNames("VariableCollectionUpsertInput", "inputFields", [
  "environmentId", "projectId", "serviceId", "skipDeploys", "variables",
]);
requireNames("VolumeCreateInput", "inputFields", ["environmentId", "mountPath", "projectId", "region", "serviceId"]);
requireNames("ServiceDomainCreateInput", "inputFields", ["environmentId", "serviceId", "targetPort"]);
requireNames("DeploymentListInput", "inputFields", ["environmentId", "includeDeleted", "projectId", "serviceId"]);
requireArgs("Query", "deployment", ["id"]);
requireArgs("Query", "deployments", ["after", "first", "input"]);
requireArgs("Query", "domains", ["environmentId", "projectId", "serviceId"]);
requireArgs("Query", "environment", ["id", "projectId"]);
requireArgs("Query", "environments", ["projectId"]);
requireArgs("Query", "project", ["id"]);
requireArgs("Query", "projects", ["includeDeleted", "workspaceId"]);
requireArgs("Query", "serviceInstance", ["environmentId", "serviceId"]);
requireArgs("Query", "templateSourceForProject", ["projectId"]);
requireArgs("Query", "variables", ["environmentId", "projectId", "serviceId", "unrendered"]);
requireArgs("Mutation", "environmentCreate", ["input"]);
requireArgs("Mutation", "projectCreate", ["input"]);
requireArgs("Mutation", "projectDelete", ["id"]);
requireArgs("Mutation", "serviceConnect", ["id", "input"]);
requireArgs("Mutation", "serviceCreate", ["input"]);
requireArgs("Mutation", "serviceDelete", ["environmentId", "id"]);
requireArgs("Mutation", "serviceDomainCreate", ["input"]);
requireArgs("Mutation", "serviceDomainDelete", ["id"]);
requireArgs("Mutation", "serviceInstanceDeployV2", ["commitSha", "environmentId", "serviceId"]);
requireArgs("Mutation", "serviceInstanceUpdate", ["environmentId", "input", "serviceId"]);
requireArgs("Mutation", "variableCollectionUpsert", ["input"]);
requireArgs("Mutation", "volumeCreate", ["input"]);
requireArgs("Mutation", "volumeDelete", ["volumeId"]);

// Deliberately print schema names only. No values or credentials are queried.
process.stdout.write(`${JSON.stringify(relevant, null, 2)}\n`);
process.stdout.write("Railway provider contract inspection passed.\n");
