export type ConnectedAppCatalogueState =
  "attention" | "connected" | "available";

export type ConnectedAppCatalogueSummary = Readonly<{
  state: ConnectedAppCatalogueState;
  statusLabel: string;
  tone: "ok" | "warn" | "error" | "info" | "muted";
}>;

export type ConnectedAppPresentation = "card" | "detail";
