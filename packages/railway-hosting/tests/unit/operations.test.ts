import { describe, expect, test } from "bun:test";

import {
  railwayDeployment,
  railwayDeploymentStop,
  railwayDeployments,
  railwayEnvironmentVolumeInstances,
  railwayProjectServices,
  railwayProjects,
  railwayProjectVolumes,
  railwayServiceConnect,
  railwayServiceCreate,
  railwayServiceInstance,
  railwayServiceInstanceLatestDeployment,
  railwayServiceInstanceDeploy,
  railwayServiceInstanceUpdate,
  railwayVariableDelete,
  railwayVariables,
  railwayVolumeCreate,
  railwayVolumeInstanceBackupCreate,
  railwayVolumeInstanceBackupList,
  railwayVolumeInstanceBackupLock,
  railwayVolumeInstanceBackupRestore,
  railwayWorkflowStatus,
} from "../../src/index";

const sourceMutationDocuments = [
  railwayServiceCreate.document,
  railwayServiceConnect.document,
  railwayServiceInstanceUpdate.document,
  railwayServiceInstanceDeploy.document,
] as const;

describe("Railway operation documents", () => {
  test("pin the live-schema service and volume operation signatures", () => {
    expect(railwayProjects.document).toContain("$includeDeleted: Boolean!");
    expect(railwayProjects.document).toContain("includeDeleted: $includeDeleted");
    expect(railwayServiceCreate.document).toContain("$input: ServiceCreateInput!");
    expect(railwayServiceCreate.document).toContain("serviceCreate(input: $input)");
    expect(railwayServiceInstanceUpdate.document).toContain("$input: ServiceInstanceUpdateInput!");
    expect(railwayServiceInstanceUpdate.document).toContain("serviceInstanceUpdate(serviceId: $serviceId");
    expect(railwayServiceInstanceUpdate.document).not.toContain("registryCredentials");
    expect(railwayServiceInstanceDeploy.document).toContain(
      "serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha)",
    );
    expect(railwayVolumeCreate.document).toBe(
      "mutation RailwayVolumeCreate($input: VolumeCreateInput!) { volumeCreate(input: $input) { id name projectId } }",
    );
    expect(railwayVolumeCreate.document).not.toContain("mountPath");
    expect(railwayVolumeCreate.document).not.toContain("serviceId");
  });

  test("pins the public backup, workflow, and quiescence operation signatures", () => {
    expect(railwayVolumeInstanceBackupList.document).toContain(
      "volumeInstanceBackupList(volumeInstanceId: $volumeInstanceId)",
    );
    expect(railwayVolumeInstanceBackupList.document).toContain(
      "id\n      name\n      createdAt\n      expiresAt\n      usedMB\n      referencedMB",
    );
    expect(railwayVolumeInstanceBackupCreate.document).toContain(
      "volumeInstanceBackupCreate(volumeInstanceId: $volumeInstanceId, name: $name) { workflowId }",
    );
    expect(railwayVolumeInstanceBackupLock.document).toContain(
      "volumeInstanceBackupLock(volumeInstanceBackupId: $volumeInstanceBackupId, volumeInstanceId: $volumeInstanceId)",
    );
    expect(railwayVolumeInstanceBackupRestore.document).toContain(
      "volumeInstanceBackupRestore(volumeInstanceBackupId: $volumeInstanceBackupId, volumeInstanceId: $volumeInstanceId) { workflowId }",
    );
    expect(railwayWorkflowStatus.document).toContain(
      "workflowStatus(workflowId: $workflowId) { status error }",
    );
    expect(railwayDeploymentStop.document).toBe(
      "mutation RailwayDeploymentStop($id: String!) { deploymentStop(id: $id) }",
    );
  });

  test("pins the separate project-volume and environment-volume-instance ownership queries", () => {
    expect(railwayProjectServices.document).toContain(
      "services(after: $after, first: $first) {",
    );
    expect(railwayProjectServices.document).toContain("node { id name templateId templateServiceId templateThreadSlug }");
    expect(railwayProjectVolumes.document).toContain(
      "volumes(after: $after, first: $first) {",
    );
    expect(railwayProjectVolumes.document).toContain("node { id name projectId }");
    expect(railwayEnvironmentVolumeInstances.document).toContain(
      "environment(id: $environmentId, projectId: $projectId)",
    );
    expect(railwayEnvironmentVolumeInstances.document).toContain(
      "node { id volumeId serviceId mountPath deletedAt isPendingDeletion }",
    );
    expect(railwayEnvironmentVolumeInstances.document).toContain("environment(id: $environmentId, projectId: $projectId) {");
    expect(railwayEnvironmentVolumeInstances.document).toContain("id\n      name\n      volumeInstances");
    for (const document of [
      railwayProjectServices.document,
      railwayProjectVolumes.document,
      railwayEnvironmentVolumeInstances.document,
    ]) {
      expect(document).toContain("edges { cursor node");
      expect(document).toContain("pageInfo { endCursor hasNextPage }");
    }
  });

  test("pins the rendered-variable adoption query", () => {
    expect(railwayVariables.isMutation).toBe(false);
    expect(railwayVariables.document).toContain("$unrendered: Boolean!");
    expect(railwayVariables.document).toContain("variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, unrendered: $unrendered)");
  });

  test("pins scoped deployment inventory for uncertain deploy recovery", () => {
    expect(railwayDeployments.document).toContain("$input: DeploymentListInput!");
    expect(railwayDeployments.document).toContain("deployments(input: $input, after: $after, first: $first)");
    expect(railwayDeployments.document).toContain("node { id status }");
    expect(railwayDeployments.document).toContain("pageInfo { endCursor hasNextPage }");
  });

  test("pins runtime instance state separately from provider deployment status", () => {
    expect(railwayDeployment.document).toContain("deploymentStopped");
    expect(railwayDeployment.document).toContain("instances { id status }");
  });

  test("pins source attachment after empty-service variable configuration", () => {
    expect(railwayServiceConnect.document).toContain("$input: ServiceConnectInput!");
    expect(railwayServiceConnect.document).toContain("serviceConnect(id: $id, input: $input)");
    expect(railwayServiceConnect.isMutation).toBe(true);
    expect(railwayServiceInstance.isMutation).toBe(false);
    expect(railwayServiceInstance.document).toContain(
      "serviceInstance(serviceId: $serviceId, environmentId: $environmentId)",
    );
    expect(railwayServiceInstance.document).toContain("source { image repo }");
    expect(railwayServiceInstance.document).toContain("startCommand");
    expect(railwayServiceInstance.document).not.toContain("latestDeployment");
    expect(railwayServiceInstanceLatestDeployment.document).toContain("latestDeployment { id status }");
  });

  test("keeps command configuration and public image attachment as separate mutations", () => {
    expect(railwayServiceInstanceUpdate.document).toContain(
      "serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)",
    );
    expect(railwayServiceConnect.document).toContain(
      "serviceConnect(id: $id, input: $input)",
    );
    expect(railwayServiceInstanceUpdate.document).not.toContain("serviceConnect(");
    expect(railwayServiceConnect.document).not.toContain("serviceInstanceUpdate(");
  });

  test("pins exact variable deletion and the explicit nullable command reset", () => {
    expect(railwayVariableDelete.document).toBe(
      "mutation RailwayVariableDelete($input: VariableDeleteInput!) {\n    variableDelete(input: $input)\n  }",
    );
    expect(railwayVariableDelete.isMutation).toBe(true);
    expect(railwayServiceInstanceUpdate.document).toContain("$input: ServiceInstanceUpdateInput!");
  });

  test("makes the public image-only contract explicit for every source mutation", () => {
    for (const document of sourceMutationDocuments) {
      expect(document).not.toContain("registryCredentials");
      expect(document).not.toContain("imagePullSecret");
      expect(document).not.toContain("privatePullAuthority");
    }
    expect(railwayServiceCreate.document).toContain("serviceCreate(input: $input)");
    expect(railwayServiceConnect.document).toContain("serviceConnect(id: $id, input: $input)");
    expect(railwayServiceInstanceUpdate.document).toContain("serviceInstanceUpdate(serviceId: $serviceId");
    expect(railwayServiceInstanceDeploy.document).toContain("serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha)");
  });
});
