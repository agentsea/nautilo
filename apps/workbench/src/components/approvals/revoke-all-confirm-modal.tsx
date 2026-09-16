import { ConfirmDialog } from "../confirm-dialog";

export function RevokeAllConfirmModal({
  count,
  onConfirm,
  onCancel,
}: {
  count: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      title={`Revoke all ${count} approvals?`}
      body="Tools will ask again next time."
      cancelLabel="Cancel"
      confirmLabel="Revoke all"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
