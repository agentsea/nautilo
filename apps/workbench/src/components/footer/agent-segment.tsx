import { useAuth } from "../../hooks/use-auth";
import { FooterSegment } from "./footer-segment";

export function AgentSegment() {
  const auth = useAuth();
  return <FooterSegment label={auth.viewer.label} title={`Actor: ${auth.viewer.label}`} />;
}
