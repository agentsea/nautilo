import type {
  DataOperationPublicationContext,
  EncryptionDataOperationOwner,
} from "../transition/encryption-data-operation-owner.ts";
import {
  decodeTaskPayloadV1,
  decodeTaskRunResultPayloadV1,
  encodeTaskPayloadV1,
  encodeTaskRunResultPayloadV1,
  type TaskPayloadV1,
  type TaskRunResultPayloadV1,
} from "./task-payload-v1.ts";
import {
  sameTaskContentCoordinateV1,
  type PreparedTaskContentCryptoRevisionV1,
  type TaskContentCoordinateV1,
  type TaskContentPayloadV1,
} from "./task-content-repository.ts";

export type OrdinaryTaskContentPublicationPlanV1 = Readonly<{
  representation: "ordinary";
  content: TaskContentPayloadV1;
  canonicalBytes: Uint8Array;
}>;

export type ProtectedTaskContentPublicationPlanV1 = Readonly<{
  representation: "protected";
  content: TaskContentPayloadV1;
  prepared: PreparedTaskContentCryptoRevisionV1;
}>;

export type DualTaskContentPublicationPlanV1 = Readonly<{
  representation: "dual";
  content: TaskContentPayloadV1;
  canonicalBytes: Uint8Array;
  prepared: PreparedTaskContentCryptoRevisionV1;
}>;

export type TaskContentPublicationPlanV1 =
  | OrdinaryTaskContentPublicationPlanV1
  | ProtectedTaskContentPublicationPlanV1
  | DualTaskContentPublicationPlanV1;

export interface TaskContentMutationPortsV1<Result> {
  prepareProtected(input: Readonly<{
    content: TaskContentPayloadV1;
    canonicalBytes: Uint8Array;
  }>): Promise<PreparedTaskContentCryptoRevisionV1>;
  reserveProtected(
    plan:
      | ProtectedTaskContentPublicationPlanV1
      | DualTaskContentPublicationPlanV1,
    context: DataOperationPublicationContext,
  ): Promise<void>;
  publish(
    plan: TaskContentPublicationPlanV1,
    context: DataOperationPublicationContext,
  ): Promise<Result>;
}

export interface TaskContentReadPortsV1 {
  readOrdinary(
    coordinate: TaskContentCoordinateV1,
  ): Promise<TaskContentPayloadV1>;
  readProtected(
    coordinate: TaskContentCoordinateV1,
  ): Promise<TaskContentPayloadV1>;
}

function canonicalContent(content: TaskContentPayloadV1): Readonly<{
  content: TaskContentPayloadV1;
  bytes: Uint8Array;
}> {
  const coordinate = Object.freeze({ ...content.coordinate });
  if (coordinate.kind === "definition") {
    const bytes = encodeTaskPayloadV1(content.payload as TaskPayloadV1);
    return Object.freeze({
      content: Object.freeze({
        coordinate,
        payload: decodeTaskPayloadV1(bytes),
      }),
      bytes,
    });
  }
  const bytes = encodeTaskRunResultPayloadV1(
    content.payload as TaskRunResultPayloadV1,
  );
  return Object.freeze({
    content: Object.freeze({
      coordinate,
      payload: decodeTaskRunResultPayloadV1(bytes),
    }),
    bytes,
  });
}

function assertPreparedForContent(
  content: TaskContentPayloadV1,
  prepared: PreparedTaskContentCryptoRevisionV1,
): void {
  if (!sameTaskContentCoordinateV1(content.coordinate, prepared.coordinate)) {
    throw new Error("Prepared Task content coordinates disagree");
  }
}

function assertReadForCoordinate(
  expected: TaskContentCoordinateV1,
  content: TaskContentPayloadV1,
): TaskContentPayloadV1 {
  if (!sameTaskContentCoordinateV1(expected, content.coordinate)) {
    throw new Error("Read Task content coordinates disagree");
  }
  return canonicalContent(content).content;
}

/**
 * Runs one content mutation through the shared transition owner. All branches
 * are lazy; only the representation selected by the current policy prepares.
 */
export async function mutateTaskContentV1<Result>(input: Readonly<{
  owner: EncryptionDataOperationOwner;
  content: TaskContentPayloadV1;
  ports: TaskContentMutationPortsV1<Result>;
}>): Promise<Result> {
  const canonical = canonicalContent(input.content);
  const prepareProtected = async () => {
    const prepared = await input.ports.prepareProtected({
      content: canonical.content,
      canonicalBytes: canonical.bytes.slice(),
    });
    assertPreparedForContent(canonical.content, prepared);
    return prepared;
  };
  return input.owner.mutate<TaskContentPublicationPlanV1, Result>({
    ordinary: () => Promise.resolve(Object.freeze({
      representation: "ordinary" as const,
      content: canonical.content,
      canonicalBytes: canonical.bytes.slice(),
    })),
    protected: async () => Object.freeze({
      representation: "protected" as const,
      content: canonical.content,
      prepared: await prepareProtected(),
    }),
    dual: async () => Object.freeze({
      representation: "dual" as const,
      content: canonical.content,
      canonicalBytes: canonical.bytes.slice(),
      prepared: await prepareProtected(),
    }),
    publish: async (plan, context) => {
      if (plan.representation !== "ordinary") {
        await input.ports.reserveProtected(plan, context);
      }
      return input.ports.publish(plan, context);
    },
  });
}

/** Protected-first reads and fallback classification remain owner-controlled. */
export function readTaskContentV1(input: Readonly<{
  owner: EncryptionDataOperationOwner;
  coordinate: TaskContentCoordinateV1;
  ports: TaskContentReadPortsV1;
}>) {
  return input.owner.read<TaskContentPayloadV1, TaskContentPayloadV1, TaskContentPayloadV1>({
    ordinary: () => input.ports.readOrdinary(input.coordinate),
    protected: () => input.ports.readProtected(input.coordinate),
    consumeOrdinary: (content) =>
      assertReadForCoordinate(input.coordinate, content),
    consumeProtected: (content) =>
      assertReadForCoordinate(input.coordinate, content),
  });
}
