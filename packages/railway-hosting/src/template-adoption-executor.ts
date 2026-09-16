import {
  railwayMe,
  railwayVariables,
} from "./operations";
import {
  RailwayGraphqlReconcileExecutor,
  type RailwayReconcileExecutorTransport,
} from "./reconcile-executor";
import type {
  RailwayTemplateAdoptionDiscovery,
  RailwayTemplateAdoptionObservation,
} from "./template-adoption";

const CANONICAL_SERVICE_NAMES = new Set([
  "app-postgres",
  "logto-postgres",
  "logto-seed",
  "logto",
  "nautilo-server",
]);

function exactCanonicalServiceSet(names: readonly string[]): boolean {
  return names.length === CANONICAL_SERVICE_NAMES.size
    && new Set(names).size === names.length
    && names.every((name) => CANONICAL_SERVICE_NAMES.has(name));
}

function stringMap(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Railway template adoption discovery failed");
  const result: Record<string, string> = {};
  for (const [key, child] of Object.entries(value)) {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(key) || typeof child !== "string" || Buffer.byteLength(child, "utf8") > 16 * 1024) {
      throw new Error("Railway template adoption discovery failed");
    }
    result[key] = child;
  }
  return Object.freeze(result);
}

function workspaceIds(value: unknown): readonly string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Railway template adoption discovery failed");
  const me = (value as Record<string, unknown>)["me"];
  if (me === null || typeof me !== "object" || Array.isArray(me)) throw new Error("Railway template adoption discovery failed");
  const workspaces = (me as Record<string, unknown>)["workspaces"];
  if (!Array.isArray(workspaces) || workspaces.length > 128) throw new Error("Railway template adoption discovery failed");
  return workspaces.map((workspace) => {
    if (workspace === null || typeof workspace !== "object" || Array.isArray(workspace)) throw new Error("Railway template adoption discovery failed");
    const id = (workspace as Record<string, unknown>)["id"];
    if (typeof id !== "string" || id.length === 0) throw new Error("Railway template adoption discovery failed");
    return id;
  });
}

/**
 * Read-only OAuth adapter for Gate 3. It first filters by the canonical service
 * names, then reads variable values only for a Nautilo-shaped project. Values
 * remain inside the returned request-memory observation and are never logged.
 */
export class RailwayGraphqlTemplateAdoptionDiscovery implements RailwayTemplateAdoptionDiscovery {
  readonly #transport: RailwayReconcileExecutorTransport;
  readonly #resources: RailwayGraphqlReconcileExecutor;

  constructor(input: { readonly transport: RailwayReconcileExecutorTransport }) {
    this.#transport = input.transport;
    this.#resources = new RailwayGraphqlReconcileExecutor({ transport: input.transport });
  }

  async #variables(input: {
    readonly projectId: string;
    readonly environmentId: string;
    readonly serviceId: string;
    readonly unrendered: boolean;
  }): Promise<Readonly<Record<string, string>>> {
    const result = await this.#transport.execute(railwayVariables, input);
    if (result.outcome !== "success") throw new Error("Railway template adoption discovery failed");
    return stringMap(result.data.variables);
  }

  async discoverNautiloShapedProjects(): Promise<readonly RailwayTemplateAdoptionObservation[]> {
    const meResult = await this.#transport.execute(railwayMe, {});
    if (meResult.outcome !== "success") throw new Error("Railway template adoption discovery failed");
    const workspaces = workspaceIds(meResult.data);
    const observations: RailwayTemplateAdoptionObservation[] = [];
    for (const workspaceId of workspaces) {
      const projects = await this.#resources.listProjects({ workspaceId });
      for (const project of projects) {
        const services = await this.#resources.listServices({ projectId: project.id });
        if (!services.some((service) => CANONICAL_SERVICE_NAMES.has(service.name))) continue;
        if (!exactCanonicalServiceSet(services.map((service) => service.name))) {
          observations.push({
            workspaceId,
            projectId: project.id,
            projectName: project.name,
            environmentId: "",
            environmentName: "",
            sourceTemplateId: null,
            sourceTemplateThreadSlug: null,
            services: [],
            volumes: [],
            domains: [],
          });
          continue;
        }
        const environments = await this.#resources.listEnvironments({ projectId: project.id });
        if (environments.length !== 1 || project.primaryEnvironmentId !== environments[0]!.id) {
          observations.push({
            workspaceId,
            projectId: project.id,
            projectName: project.name,
            environmentId: "",
            environmentName: "",
            sourceTemplateId: null,
            sourceTemplateThreadSlug: null,
            services: [],
            volumes: [],
            domains: [],
          });
          continue;
        }
        const environment = environments[0]!;
        const volumeInstances = await this.#resources.listVolumeInstances({ projectId: project.id, environmentId: environment.id });
        const volumes = await Promise.all(volumeInstances.map(async (instance) => {
          const volume = await this.#resources.getVolume({ projectId: project.id, volumeId: instance.volumeId });
          return {
            id: instance.volumeId,
            name: volume?.name ?? "",
            serviceId: instance.serviceId ?? "",
            mountPath: instance.mountPath,
          };
        }));
        const serviceObservations = await Promise.all(services.map(async (service) => {
          const [instance, deployments, renderedData, unrenderedData] = await Promise.all([
            this.#resources.getServiceInstance({ serviceId: service.id, environmentId: environment.id }),
            this.#resources.listDeploymentsRaw({ projectId: project.id, environmentId: environment.id, serviceId: service.id }),
            this.#variables({ projectId: project.id, environmentId: environment.id, serviceId: service.id, unrendered: false }),
            this.#variables({ projectId: project.id, environmentId: environment.id, serviceId: service.id, unrendered: true }),
          ]);
          return {
            id: service.id,
            name: service.name,
            image: instance?.source?.image ?? null,
            startCommand: instance?.startCommand ?? null,
            templateId: service.templateId ?? null,
            templateServiceId: service.templateServiceId ?? null,
            templateThreadSlug: service.templateThreadSlug ?? null,
            deploymentId: deployments.length === 1 ? deployments[0]!.id : "",
            deploymentStatus: deployments.length === 1 ? deployments[0]!.status : "INVALID",
            variables: renderedData,
            unrenderedVariables: unrenderedData,
          };
        }));
        const domains = (await Promise.all(services.map(async (service) => (
          await this.#resources.listDomains({ projectId: project.id, environmentId: environment.id, serviceId: service.id })
        )))).flatMap((entries, index) => entries.map((domain) => ({
          id: domain.id,
          serviceId: services[index]!.id,
          targetPort: domain.targetPort ?? 0,
        })));
        const templateIds = new Set(services.map((service) => service.templateId));
        const templateThreadSlugs = new Set(services.map((service) => service.templateThreadSlug ?? null));
        const sourceTemplateId = templateIds.size === 1 && typeof services[0]?.templateId === "string"
          ? services[0].templateId
          : null;
        const sourceTemplateThreadSlug = templateThreadSlugs.size === 1
          ? services[0]?.templateThreadSlug ?? null
          : null;
        observations.push({
          workspaceId,
          projectId: project.id,
          projectName: project.name,
          environmentId: environment.id,
          environmentName: environment.name,
          sourceTemplateId,
          sourceTemplateThreadSlug,
          services: serviceObservations,
          volumes,
          domains,
        });
      }
    }
    return observations;
  }
}
