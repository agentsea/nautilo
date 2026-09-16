import type { HostingResourceReference } from "@nautilo/hosting";

import type { RailwayDestroyExecutor, RailwayDestroyInventoryEntry } from "./destroy";
import {
  railwayProjectDelete,
  railwayServiceDomainDelete,
  railwayVolumeDelete,
} from "./operations";
import {
  RailwayGraphqlReconcileExecutor,
  RailwayReconcileExecutorError,
  type RailwayGraphqlReconcileExecutorOptions,
  type RailwayReconcileExecutorTransport,
} from "./reconcile-executor";
import type { RailwayGraphqlVariables, RailwayOperation } from "./types";

export interface RailwayGraphqlDestroyExecutorOptions extends RailwayGraphqlReconcileExecutorOptions {
  readonly workspaceId: string;
  readonly environmentId: string;
}

/** Concrete exact-receipt teardown adapter. It never searches by resource name. */
export class RailwayGraphqlDestroyExecutor implements RailwayDestroyExecutor {
  readonly #transport: RailwayReconcileExecutorTransport;
  readonly #resources: RailwayGraphqlReconcileExecutor;
  readonly #workspaceId: string;
  readonly #environmentId: string;

  constructor(options: RailwayGraphqlDestroyExecutorOptions) {
    if (!options.workspaceId || !options.environmentId) throw new RailwayReconcileExecutorError();
    this.#transport = options.transport;
    this.#resources = new RailwayGraphqlReconcileExecutor(options);
    this.#workspaceId = options.workspaceId;
    this.#environmentId = options.environmentId;
  }

  async #execute<Variables extends RailwayGraphqlVariables, Data>(
    operation: RailwayOperation<string, Variables, Data>,
    variables: Variables,
  ): Promise<Data> {
    const result = await this.#transport.execute(operation, variables);
    if (result.outcome !== "success") throw new RailwayReconcileExecutorError();
    return result.data;
  }

  async deleteDomain(input: { readonly domainId: string }): Promise<void> {
    const data = await this.#execute(railwayServiceDomainDelete, { id: input.domainId });
    if (data.serviceDomainDelete !== true) throw new RailwayReconcileExecutorError();
  }

  async deleteVolume(input: { readonly volumeId: string }): Promise<void> {
    const data = await this.#execute(railwayVolumeDelete, { volumeId: input.volumeId });
    if (data.volumeDelete !== true) throw new RailwayReconcileExecutorError();
  }

  async deleteService(input: { readonly serviceId: string; readonly environmentId?: string | undefined }): Promise<void> {
    await this.#resources.deleteService({
      serviceId: input.serviceId,
      environmentId: input.environmentId ?? this.#environmentId,
    });
  }

  async deleteProject(input: { readonly projectId: string }): Promise<void> {
    const data = await this.#execute(railwayProjectDelete, { id: input.projectId });
    if (data.projectDelete !== true) throw new RailwayReconcileExecutorError();
  }

  async getProject(input: { readonly projectId: string }) {
    const projects = await this.#resources.listProjects({ workspaceId: this.#workspaceId });
    return projects.find((project) => project.id === input.projectId) ?? null;
  }

  async #inventory(projectId: string): Promise<readonly RailwayDestroyInventoryEntry[]> {
    const project = await this.getProject({ projectId });
    if (project === null) return [];
    const survivors = await this.#resources.inventorySurvivors({
      projectId,
      environmentId: this.#environmentId,
    });
    const inventory: RailwayDestroyInventoryEntry[] = survivors.map(({ kind, id }) => ({ kind, id }));
    const services = await this.#resources.listServices({ projectId });
    for (const service of services) {
      const domains = await this.#resources.listDomains({
        projectId,
        environmentId: this.#environmentId,
        serviceId: service.id,
      });
      inventory.push(...domains.map((domain) => ({ kind: "railway.domain", id: domain.id })));
    }
    return inventory;
  }

  async inventoryProjectResources(input: { readonly projectId: string }): Promise<readonly RailwayDestroyInventoryEntry[]> {
    return (await this.#inventory(input.projectId)).filter((entry) => entry.kind !== "railway.project");
  }

  async inventoryReceiptResources(input: {
    readonly projectId: string;
    readonly resources: readonly HostingResourceReference[];
  }): Promise<readonly RailwayDestroyInventoryEntry[]> {
    const inventory = await this.#inventory(input.projectId);
    const identities = new Set(input.resources.map((resource) => `${resource.kind}\0${resource.id}`));
    return inventory.filter((entry) => identities.has(`${entry.kind}\0${entry.id}`));
  }
}
