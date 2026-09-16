import type { SecurityPosture } from "../../contexts/posture-context";

export function postureTone(level: SecurityPosture["securityLevel"]): string {
  switch (level) {
    case "paranoid":
    case "yolo":
      return "var(--error)";
    case "cautious":
      return "var(--warning)";
    case "permissive":
      return "var(--success)";
    case "standard":
      return "var(--foreground-muted)";
  }
}

export function formatLevel(level: SecurityPosture["securityLevel"]): string {
  return level;
}
