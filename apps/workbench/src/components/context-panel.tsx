import { AssistantIdentity } from "./identity/assistant-identity";
import { useLocation } from "react-router-dom";

export function ContextPanel() {
  const location = useLocation();
  const showSubagentDock =
    location.pathname === "/" ||
    location.pathname === "/info" ||
    location.pathname.startsWith("/rooms/");
  return <AssistantIdentity variant="panel" showSubagentDock={showSubagentDock} />;
}
