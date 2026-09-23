import type {
  DualTaskPreparedCreateRequestV1,
  DualTaskPreparedUpdateRequestV1,
  ProtectedTaskDefinitionReadReadyEnvelopeV1,
  ProtectedTaskPreparedCreateRequestV1,
  ProtectedTaskPreparedUpdateRequestV1,
  ProtectedTaskPublicationPlanRequestV1,
  ProtectedTaskPublicationPlanV1,
} from "@nautilo/api-client";
import type {
  ListTasksQuery,
  TaskContentListV1,
  TaskContentSummaryV1,
  TaskCreateResponse,
} from "@nautilo/types";

export type ProtectedTaskRouteAuthority = Readonly<{
  userId: string;
  subjectHumanId: string;
  actorId: string;
  agentId: string;
}>;

export interface ProtectedTaskRoutePorts {
  list(input: Readonly<{
    authority: ProtectedTaskRouteAuthority;
    query: ListTasksQuery;
  }>): Promise<TaskContentListV1>;
  readDefinition(input: Readonly<{
    authority: ProtectedTaskRouteAuthority;
    taskId: string;
    objectId: string;
    contentRevision: number;
    cryptoAccessRevision: 0;
  }>): Promise<ProtectedTaskDefinitionReadReadyEnvelopeV1>;
  plan(input: Readonly<{
    authority: ProtectedTaskRouteAuthority;
    taskId: string | null;
    request: ProtectedTaskPublicationPlanRequestV1;
  }>): Promise<ProtectedTaskPublicationPlanV1>;
  publishCreate(input: Readonly<{
    authority: ProtectedTaskRouteAuthority;
    prepared: ProtectedTaskPreparedCreateRequestV1 | DualTaskPreparedCreateRequestV1;
  }>): Promise<TaskCreateResponse>;
  publishUpdate(input: Readonly<{
    authority: ProtectedTaskRouteAuthority;
    taskId: string;
    prepared: ProtectedTaskPreparedUpdateRequestV1 | DualTaskPreparedUpdateRequestV1;
  }>): Promise<TaskContentSummaryV1>;
}

declare const PROTECTED_TASK_TEST_AUTHORITY: unique symbol;
export type ProtectedTaskTestAuthority = Readonly<{
  [PROTECTED_TASK_TEST_AUTHORITY]: true;
}>;

export type ProtectedTaskComposition = Readonly<{
  mode: "protected_task_test_shadow";
  target: ProtectedTaskRouteAuthority;
  ports: ProtectedTaskRoutePorts;
}>;

const authorities = new WeakSet<object>();
const compositions = new WeakSet<object>();

export function createProtectedTaskTestAuthority(): ProtectedTaskTestAuthority {
  const authority = Object.freeze({}) as ProtectedTaskTestAuthority;
  authorities.add(authority);
  return authority;
}

export function createProtectedTaskTestComposition(input: Readonly<{
  authority: ProtectedTaskTestAuthority;
  target: ProtectedTaskRouteAuthority;
  ports: ProtectedTaskRoutePorts;
}>): ProtectedTaskComposition {
  if (!authorities.has(input.authority as object)) {
    throw new TypeError("Protected Task test authority is not recognized");
  }
  const composition = Object.freeze({
    mode: "protected_task_test_shadow" as const,
    target: Object.freeze({ ...input.target }),
    ports: input.ports,
  });
  compositions.add(composition);
  return composition;
}

function sameAuthority(
  left: ProtectedTaskRouteAuthority,
  right: ProtectedTaskRouteAuthority,
): boolean {
  return left.userId === right.userId
    && left.subjectHumanId === right.subjectHumanId
    && left.actorId === right.actorId
    && left.agentId === right.agentId;
}

export function resolveProtectedTaskComposition(input: Readonly<{
  composition: ProtectedTaskComposition;
  authority: ProtectedTaskRouteAuthority;
}>): ProtectedTaskRoutePorts | null {
  return compositions.has(input.composition as object)
      && input.composition.mode === "protected_task_test_shadow"
      && sameAuthority(input.composition.target, input.authority)
    ? input.composition.ports
    : null;
}
