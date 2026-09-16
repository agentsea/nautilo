import { InMemoryDocumentLockManager } from "@nautilo/document-mutations";

/**
 * One process-local lock domain for every server-side Workspace document
 * mutation and Workspace human-edit lease registration.
 */
export const workspaceDocumentMutationLockManager =
  new InMemoryDocumentLockManager();
