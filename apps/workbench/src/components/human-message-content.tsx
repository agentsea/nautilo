import { useMessage } from "@assistant-ui/react";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

/** Receive progress is UI state, not searchable/copyable message prose. */
export function HumanMessageContent({ children }: { children: ReactNode }) {
  const verification = useMessage((message) => message.metadata.custom?.humanMessageVerification);
  if (verification === "pending") {
    return (
      <span role="status" aria-label="Decrypting message" className="inline-flex items-center text-foreground-muted">
        <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
      </span>
    );
  }
  if (verification === "failed") {
    return (
      <span role="status" className="text-xs text-foreground-muted">
        Couldn’t verify message. Reload to retry.
      </span>
    );
  }
  return children;
}
