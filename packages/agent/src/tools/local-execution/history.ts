/** A reference opened by the current conversation's transcript authority.
 * The model supplies only an execution locator, never these authority fields. */
export interface LocalExecutionHistoryReference {
  readonly executionId: string;
  readonly generation: string;
  readonly sourceMessageId: number;
}

/** Invocation-local capability. The source is admitted again after the read,
 * before recovered bytes can become a new Tool Message. Never checkpoint it. */
export interface LocalExecutionHistoryPort {
  withReference<T>(executionId: string, read: (reference: LocalExecutionHistoryReference) => Promise<T>): Promise<T>;
}
