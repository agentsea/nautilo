import { FOOTER_HEIGHT_PX, SHELL_FOOTER_CLASSES } from "../../layouts/chrome-shell.layout";
import { PostureBadge } from "../security/posture-badge";
import { AgentSegment } from "./agent-segment";
import { ConnectionSegment } from "./connection-segment";
import { CurrentFolderSegment } from "./current-folder-segment";

export function Footer() {
  return (
    <footer className={SHELL_FOOTER_CLASSES} style={{ height: FOOTER_HEIGHT_PX }} aria-label="Workbench status">
      <ConnectionSegment />
      <FooterSeparator />
      <AgentSegment />
      <FooterSeparator />
      <CurrentFolderSegment />
      <FooterSeparator />
      <PostureBadge />
    </footer>
  );
}

function FooterSeparator() {
  return <span className="text-foreground-disabled">·</span>;
}
