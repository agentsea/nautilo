export type SecurityLevel = "yolo" | "permissive" | "standard" | "cautious" | "paranoid";

export type SecurityLayers = {
  commandScanning: boolean;
  pathDeny: boolean;
  contentScanning: boolean;
  ast: boolean;
  subagent: boolean;
  sandbox: boolean;
};

const LEVEL_MAP: Record<SecurityLevel, SecurityLayers> = {
  yolo:       { commandScanning: false, pathDeny: false, contentScanning: false, ast: false, subagent: false, sandbox: false },
  permissive: { commandScanning: false, pathDeny: true,  contentScanning: false, ast: false, subagent: false, sandbox: false },
  standard:   { commandScanning: true,  pathDeny: true,  contentScanning: true,  ast: false, subagent: false, sandbox: false },
  cautious:   { commandScanning: true,  pathDeny: true,  contentScanning: true,  ast: false, subagent: false, sandbox: false },
  paranoid:   { commandScanning: true,  pathDeny: true,  contentScanning: true,  ast: false, subagent: false, sandbox: false },
};

export function resolveSecurityLayers(level: SecurityLevel): SecurityLayers {
  return LEVEL_MAP[level];
}
