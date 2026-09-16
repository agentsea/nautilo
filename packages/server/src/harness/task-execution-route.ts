import type {
  ForegroundExecutionRoute,
  TaskExecutionRouteFacts,
  TaskExecutionRouteSelector,
} from "@nautilo/runtime";

const MAX_HARNESS_ID_BYTES = 64;

/**
 * The only harness-routing data that may cross from the persisted Task reader
 * into the generic route.  The reader is server-owned and must reduce any
 * provider-private metadata to this exact value before returning it here.
 */
export interface TaskHarnessExecutionDescriptor {
  readonly version: 1;
  readonly harnessId: string;
  readonly source: "genie";
}

/**
 * Canonical Task identity reloaded after TaskRun creation and target-Room
 * resolution. Raw Task metadata, prompts, profiles, host paths, and launch
 * details intentionally do not belong to this generic seam.
 */
export interface PersistedTaskHarnessRoute {
  readonly id: string;
  readonly ownerId: string;
  readonly requestorId: string;
  readonly agentId: string;
  readonly parentTaskId: string | null;
  readonly targetRoomId: string | null;
  readonly execution: TaskHarnessExecutionDescriptor | null;
}

/** Reloading the Task prevents a route selector from trusting caller-shaped data. */
export interface TaskHarnessExecutionRouteReader {
  getTask(taskId: string): Promise<PersistedTaskHarnessRoute | null>;
}

/**
 * The provider-owned selector receives only immutable canonical facts and the
 * exact reviewed harness descriptor. Provider-private admission and projection
 * contracts remain outside this generic router.
 */
export interface TaskHarnessExecutionRouteInput {
  readonly facts: TaskExecutionRouteFacts;
  readonly descriptor: TaskHarnessExecutionDescriptor;
}

export interface TaskHarnessExecutionRouteProvider {
  select(input: TaskHarnessExecutionRouteInput):
    | Promise<ForegroundExecutionRoute | undefined>
    | ForegroundExecutionRoute
    | undefined;
}

/**
 * Selector factories are lazy: an optional harness cannot initialize merely
 * because another harness is listed or a Native Task is dispatched.
 */
export interface TaskHarnessExecutionRouteRegistration {
  readonly harnessId: string;
  /** Exact provider-owned codes reviewed as safe for durable TaskRun status. */
  readonly publicFailureCodes?: readonly string[];
  createSelector(): TaskHarnessExecutionRouteProvider;
}

export type TaskHarnessExecutionRouteFailureCode =
  | "TASK_HARNESS_DUPLICATE_REGISTRATION"
  | "TASK_HARNESS_TASK_UNAVAILABLE"
  | "TASK_HARNESS_DESCRIPTOR_INVALID"
  | "TASK_HARNESS_FACTS_MISMATCH"
  | "TASK_HARNESS_UNKNOWN"
  | "TASK_HARNESS_SELECTOR_UNAVAILABLE"
  | "TASK_HARNESS_ROUTE_UNAVAILABLE";

/** A bounded public failure vocabulary; no provider or host detail crosses it. */
export class TaskHarnessExecutionRouteFailure extends Error {
  constructor(readonly code: TaskHarnessExecutionRouteFailureCode) {
    super(code);
    this.name = "TaskHarnessExecutionRouteFailure";
  }
}

/**
 * Provider selectors may preserve only a registration-allowlisted stable code.
 * The constructor strips cause/detail and bounds the code before the router
 * decides whether that exact registration is allowed to expose it.
 */
export class TaskHarnessExecutionRouteProviderFailure extends Error {
  readonly code: string;

  constructor(code: string) {
    const boundedCode = isPublicFailureCode(code)
      ? code
      : "TASK_HARNESS_ROUTE_UNAVAILABLE";
    super(boundedCode);
    this.name = "TaskHarnessExecutionRouteProviderFailure";
    this.code = boundedCode;
  }
}

export interface TaskHarnessExecutionRouterDeps {
  readonly tasks: TaskHarnessExecutionRouteReader;
  readonly registrations: readonly TaskHarnessExecutionRouteRegistration[];
}

/**
 * Strict server-owned harness dispatch boundary for a durable TaskRun. Native
 * Tasks bypass it. A Task that declares a harness must select its exact
 * reviewed registration or fail; it never falls back to Native or a sibling.
 */
export class TaskHarnessExecutionRouter {
  private readonly registrations = new Map<string, TaskHarnessExecutionRouteRegistration>();
  private readonly selectors = new Map<string, TaskHarnessExecutionRouteProvider>();

  constructor(private readonly deps: TaskHarnessExecutionRouterDeps) {
    for (const registration of deps.registrations) {
      if (!isHarnessId(registration.harnessId) || this.registrations.has(registration.harnessId)) {
        throw new TaskHarnessExecutionRouteFailure("TASK_HARNESS_DUPLICATE_REGISTRATION");
      }
      this.registrations.set(registration.harnessId, registration);
    }
  }

  readonly select = async (
    facts: TaskExecutionRouteFacts,
  ): Promise<ForegroundExecutionRoute | undefined> => {
    const task = await this.deps.tasks.getTask(facts.taskId);
    if (!task) throw new TaskHarnessExecutionRouteFailure("TASK_HARNESS_TASK_UNAVAILABLE");
    if (!task.execution) return undefined;
    if (!isTaskHarnessExecutionDescriptor(task.execution)) {
      throw new TaskHarnessExecutionRouteFailure("TASK_HARNESS_DESCRIPTOR_INVALID");
    }
    if (!hasExactFacts(task, facts)) {
      throw new TaskHarnessExecutionRouteFailure("TASK_HARNESS_FACTS_MISMATCH");
    }

    const registration = this.registrations.get(task.execution.harnessId);
    if (!registration) throw new TaskHarnessExecutionRouteFailure("TASK_HARNESS_UNKNOWN");

    const selector = this.selectorFor(registration);
    const input = Object.freeze({
      facts: Object.freeze({ ...facts }),
      descriptor: Object.freeze({ ...task.execution }),
    }) satisfies TaskHarnessExecutionRouteInput;
    try {
      const route = await selector.select(input);
      if (!route) throw new TaskHarnessExecutionRouteFailure("TASK_HARNESS_ROUTE_UNAVAILABLE");
      return route;
    } catch (error) {
      if (
        error instanceof TaskHarnessExecutionRouteProviderFailure
        && registration.publicFailureCodes?.includes(error.code)
      ) {
        // Reconstruct the reviewed code rather than rethrowing a provider-owned
        // Error instance. A provider may attach a cause or arbitrary detail to
        // its error object; neither may cross this generic durable-task seam.
        throw new TaskHarnessExecutionRouteProviderFailure(error.code);
      }
      // Provider errors may contain host paths, upstream text, or private
      // admission detail. Collapse every unreviewed selection failure here.
      throw new TaskHarnessExecutionRouteFailure("TASK_HARNESS_ROUTE_UNAVAILABLE");
    }
  };

  private selectorFor(
    registration: TaskHarnessExecutionRouteRegistration,
  ): TaskHarnessExecutionRouteProvider {
    const existing = this.selectors.get(registration.harnessId);
    if (existing) return existing;
    try {
      const selector = registration.createSelector();
      if (!selector || typeof selector.select !== "function") {
        throw new Error("invalid selector");
      }
      this.selectors.set(registration.harnessId, selector);
      return selector;
    } catch {
      // Do not cache failure: a transient optional-harness initialization may
      // be retried on a later exact selection without affecting siblings.
      throw new TaskHarnessExecutionRouteFailure("TASK_HARNESS_SELECTOR_UNAVAILABLE");
    }
  }
}

export function createTaskHarnessExecutionRouteSelector(
  deps: TaskHarnessExecutionRouterDeps,
): TaskExecutionRouteSelector {
  return new TaskHarnessExecutionRouter(deps).select;
}

export function isTaskHarnessExecutionDescriptor(
  value: unknown,
): value is TaskHarnessExecutionDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const descriptor = value as Record<string, unknown>;
  const keys = Object.keys(descriptor).sort();
  return keys.length === 3
    && keys[0] === "harnessId"
    && keys[1] === "source"
    && keys[2] === "version"
    && descriptor["version"] === 1
    && descriptor["source"] === "genie"
    && isHarnessId(descriptor["harnessId"]);
}

function hasExactFacts(
  task: PersistedTaskHarnessRoute,
  facts: TaskExecutionRouteFacts,
): boolean {
  return task.id === facts.taskId
    && task.ownerId === facts.ownerId
    && task.requestorId === facts.requestorId
    && task.agentId === facts.agentId
    && task.parentTaskId === facts.parentTaskId
    && task.targetRoomId === facts.roomId;
}

function isHarnessId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && new TextEncoder().encode(value).byteLength <= MAX_HARNESS_ID_BYTES;
}

function isPublicFailureCode(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Z][A-Z0-9_]*$/.test(value)
    && new TextEncoder().encode(value).byteLength <= MAX_HARNESS_ID_BYTES;
}
