export interface PersonalLlmAttemptOwnerBinding {
  /** Random once for one server runtime; a restart must use a new token. */
  readonly ownerToken: string;
}

let activeOwner: PersonalLlmAttemptOwnerBinding | null = null;

/** Install the sole foreground direct-attempt owner for this process. */
export function installPersonalLlmAttemptOwner(
  binding: PersonalLlmAttemptOwnerBinding,
): () => void {
  if (!binding.ownerToken.trim()) throw new Error("Personal LLM attempt owner token is required");
  if (activeOwner !== null) throw new Error("Personal LLM attempt owner is already installed");
  const installed = Object.freeze({ ownerToken: binding.ownerToken });
  activeOwner = installed;
  return () => {
    // A stale shutdown must never remove a later process binding in tests or
    // an embedded lifecycle that installs another owner after complete stop.
    if (activeOwner === installed) activeOwner = null;
  };
}

export function getPersonalLlmAttemptOwner(): PersonalLlmAttemptOwnerBinding | null {
  return activeOwner;
}
