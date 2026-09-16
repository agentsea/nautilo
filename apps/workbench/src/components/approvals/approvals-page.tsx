import { useAuth } from "../../hooks/use-auth";
import { GuestPlaceholder } from "../../pages/settings/ui";
import { ApprovalsPane } from "./approvals-pane";

/** Full-width route page for `/approvals` (D235 Phase 3). */
export function ApprovalsPage() {
  const auth = useAuth();

  if (!auth.viewer.isVerified) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-6">
        <GuestPlaceholder what="Approvals" />
      </div>
    );
  }

  return <ApprovalsPane />;
}
