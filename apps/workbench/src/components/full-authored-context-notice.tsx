import { useConversationEncryptionPolicyMode } from
  "../adapters/runtime-contexts";

export function FullAuthoredContextNotice() {
  const mode = useConversationEncryptionPolicyMode();
  if (mode !== "encrypted_only") return null;

  return (
    <div
      role="status"
      className="mb-2 rounded-md border border-border bg-background-element px-3 py-2 text-xs text-foreground-muted"
    >
      Full encryption is on for supported conversation content. Custom Soul and
      authored Skills remain ordinary plaintext; these are the only Full
      encryption exceptions. Unsupported operations are withheld.
    </div>
  );
}
