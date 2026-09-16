import type { ReactElement } from "react";
import { CreatedWorkspaceArtifactBody, type OfficeCliCreatedArtifactReceipt } from "./officecli";
import type { ToolRenderer, ToolRendererProps } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseWriterCreatedArtifactReceipt(
  resultText: string | undefined,
  truncated = false,
): OfficeCliCreatedArtifactReceipt | null {
  if (!resultText || truncated) return null;
  try {
    const value = JSON.parse(resultText) as Record<string, unknown> | null;
    if (!value || value["ok"] !== true || value["status"] !== "created" ||
        typeof value["artifactInternalId"] !== "string" || !UUID.test(value["artifactInternalId"]) ||
        typeof value["artifactId"] !== "string" || !value["artifactId"] ||
        typeof value["artifactPath"] !== "string" || !value["artifactPath"] ||
        !value["target"] || typeof value["target"] !== "object" ||
        (value["target"] as Record<string, unknown>)["surface"] !== "workspace") return null;
    return { artifactInternalId: value["artifactInternalId"], artifactId: value["artifactId"], path: value["artifactPath"] };
  } catch {
    return null;
  }
}

function WriterCreatedBody({ state, resultText, resultTruncated }: ToolRendererProps): ReactElement {
  const receipt = state === "success" ? parseWriterCreatedArtifactReceipt(resultText, resultTruncated) : null;
  return <CreatedWorkspaceArtifactBody receipt={receipt} resultText={resultText} />;
}

export const writerCreationRenderer: ToolRenderer = {
  displayName: "Writer document",
  collapsedSummary: ({ state, resultText, resultTruncated }) => {
    const receipt = state === "success" ? parseWriterCreatedArtifactReceipt(resultText, resultTruncated) : null;
    return receipt ? `Created ${receipt.path.split("/").pop()}` : "Create document";
  },
  autoExpandOnResult: true,
  ExpandedBody: WriterCreatedBody,
};
