import {
  type TaskRuntimeCheckpointIdentity,
} from "@nautilo/lattice-crypto";

import {
  type ProtectedCheckpointCellCrypto,
  type ProtectedCheckpointInvocationScope,
} from "./protected-checkpoint-cell-crypto.ts";

export type TaskRuntimeCheckpointCellIdentity =
  TaskRuntimeCheckpointIdentity & Readonly<{ graphThreadId: string }>;

export type TaskRuntimeCheckpointCellCrypto = Readonly<{
  crypto: ProtectedCheckpointCellCrypto;
  scope: ProtectedCheckpointInvocationScope;
}>;
