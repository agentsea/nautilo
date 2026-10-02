import type { ServingTransport } from "@nautilo/types";
import type { ReactElement } from "react";

export function ServingTransportAttribution({
  transport,
}: {
  readonly transport?: ServingTransport;
}): ReactElement | null {
  if (transport !== "surplus") return null;
  return (
    <span
      className="text-[11px] font-medium normal-case text-foreground-muted"
      data-testid="serving-transport-attribution"
    >
      via Surplus
    </span>
  );
}
