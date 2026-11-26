import { SERVER_ROLE_RANK, type ServerRoleSlug } from "@nautilo/trust";

export function canResetPasswordForRole(
  callerRole: ServerRoleSlug | null,
  targetRole: ServerRoleSlug | null,
): boolean {
  return callerRole !== null
    && SERVER_ROLE_RANK[callerRole] <= SERVER_ROLE_RANK[targetRole ?? "guest"];
}
