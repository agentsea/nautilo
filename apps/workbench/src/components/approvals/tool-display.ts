import type { LucideIcon } from "lucide-react";
import { FileText, Globe, KeyRound, Terminal, Wrench } from "lucide-react";
import type { CommandApprovalRow } from "@nautilo/api-client";

/** Tool-family buckets for chip filters. "other" is a catch-all with no chip. */
export type ToolFamily = "shell" | "files" | "network" | "capabilities" | "other";

export type ToolFamilyChip = ToolFamily | "all";

export const TOOL_FAMILY_CHIP_ORDER: readonly Exclude<ToolFamilyChip, "all">[] = [
  "shell",
  "files",
  "network",
  "capabilities",
] as const;

export const TOOL_FAMILY_LABELS: Record<ToolFamilyChip, string> = {
  all: "All",
  shell: "Shell",
  files: "Files",
  network: "Network",
  capabilities: "Capabilities",
  other: "Other",
};

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  run_shell: "Run shell command",
  file: "File access",
  web_fetch: "Fetch URL",
  _capability: "Capability",
};

function isCapabilityRow(row: CommandApprovalRow): boolean {
  return row.approvalKind === "capability" || row.toolPattern === "_capability";
}

/** Whether the row uses a mapped friendly headline (vs raw toolPattern fallback). */
export function hasMappedToolDisplay(row: CommandApprovalRow): boolean {
  if (isCapabilityRow(row)) return true;
  if (row.toolPattern in TOOL_DISPLAY_NAMES) return true;
  if (row.toolPattern.startsWith("file")) return true;
  return false;
}

export function getApprovalHeadline(row: CommandApprovalRow): string {
  if (isCapabilityRow(row)) {
    return TOOL_DISPLAY_NAMES._capability ?? "Capability";
  }
  const direct = TOOL_DISPLAY_NAMES[row.toolPattern];
  if (direct) return direct;
  if (row.toolPattern.startsWith("file")) {
    return TOOL_DISPLAY_NAMES.file ?? "File access";
  }
  return row.toolPattern;
}

/** Strip the leading tool token from the server label for mapped rows. */
export function getApprovalSubline(row: CommandApprovalRow): string {
  if (!hasMappedToolDisplay(row)) {
    return row.label;
  }

  if (isCapabilityRow(row)) {
    const prefix = "capability: ";
    return row.label.startsWith(prefix) ? row.label.slice(prefix.length) : row.label;
  }

  const { label, toolPattern } = row;
  if (label === toolPattern) return "";
  if (label.startsWith(`${toolPattern} `)) {
    return label.slice(toolPattern.length + 1);
  }
  return label;
}

export function classifyToolFamily(row: CommandApprovalRow): ToolFamily {
  if (isCapabilityRow(row)) return "capabilities";
  const { toolPattern } = row;
  if (toolPattern === "run_shell" || toolPattern.startsWith("run_shell.")) {
    return "shell";
  }
  if (toolPattern.startsWith("file")) return "files";
  if (toolPattern === "web_fetch" || toolPattern.startsWith("web_")) {
    return "network";
  }
  return "other";
}

export function toolFamilyIcon(family: ToolFamily): LucideIcon {
  switch (family) {
    case "shell":
      return Terminal;
    case "files":
      return FileText;
    case "network":
      return Globe;
    case "capabilities":
      return KeyRound;
    default:
      return Wrench;
  }
}

export function countByToolFamily(
  rows: readonly CommandApprovalRow[],
): Record<ToolFamilyChip, number> {
  const counts: Record<ToolFamilyChip, number> = {
    all: rows.length,
    shell: 0,
    files: 0,
    network: 0,
    capabilities: 0,
    other: 0,
  };
  for (const row of rows) {
    counts[classifyToolFamily(row)] += 1;
  }
  return counts;
}
