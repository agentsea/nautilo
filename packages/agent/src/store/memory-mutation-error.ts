/** Typed Memory authority/CAS failures, without loading the database adapter. */
export class MemoryMutationAuthorityError extends Error {
  constructor(readonly reason: "memory_unavailable" | "source_changed") {
    super(reason);
    this.name = "MemoryMutationAuthorityError";
  }
}
