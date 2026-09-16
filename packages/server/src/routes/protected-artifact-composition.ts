import type {
  HumanArtifactRouteAuthority,
  HumanArtifactRoutePorts,
} from "@nautilo/lattice-bridge/server";

declare const PROTECTED_ARTIFACT_TEST_AUTHORITY: unique symbol;
export type ProtectedArtifactTestAuthority = Readonly<{
  [PROTECTED_ARTIFACT_TEST_AUTHORITY]: true;
}>;

const authorities = new WeakSet<object>();
const compositions = new WeakSet<object>();

export function createProtectedArtifactTestAuthority(): ProtectedArtifactTestAuthority {
  const authority = Object.freeze({}) as ProtectedArtifactTestAuthority;
  authorities.add(authority);
  return authority;
}

export type ProtectedArtifactComposition = Readonly<{
  mode: "protected_artifact_test_shadow";
  target: HumanArtifactRouteAuthority;
  ports: HumanArtifactRoutePorts;
}>;

function exactIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function exactAuthority(
  left: HumanArtifactRouteAuthority,
  right: HumanArtifactRouteAuthority,
): boolean {
  return left.userId === right.userId
    && left.subjectHumanId === right.subjectHumanId
    && left.actorId === right.actorId
    && left.agentId === null
    && right.agentId === null
    && exactIds(left.readableNamespaceIds, right.readableNamespaceIds)
    && exactIds(left.mutableNamespaceIds, right.mutableNamespaceIds)
    && exactIds(left.writableNamespaceIds, right.writableNamespaceIds);
}

export function createProtectedArtifactTestComposition(input: Readonly<{
  authority: ProtectedArtifactTestAuthority;
  target: HumanArtifactRouteAuthority;
  ports: HumanArtifactRoutePorts;
}>): ProtectedArtifactComposition {
  if (!authorities.has(input.authority as object)) {
    throw new TypeError("Protected Artifact test authority is not recognized");
  }
  const composition = Object.freeze({
    mode: "protected_artifact_test_shadow" as const,
    target: Object.freeze({
      ...input.target,
      readableNamespaceIds: Object.freeze([...input.target.readableNamespaceIds]),
      mutableNamespaceIds: Object.freeze([...input.target.mutableNamespaceIds]),
      writableNamespaceIds: Object.freeze([...input.target.writableNamespaceIds]),
    }),
    ports: input.ports,
  });
  compositions.add(composition);
  return composition;
}

export function resolveProtectedArtifactComposition(input: Readonly<{
  composition: ProtectedArtifactComposition;
  authority: HumanArtifactRouteAuthority;
}>): HumanArtifactRoutePorts | null {
  return compositions.has(input.composition as object)
      && input.composition.mode === "protected_artifact_test_shadow"
      && exactAuthority(input.composition.target, input.authority)
    ? input.composition.ports
    : null;
}
