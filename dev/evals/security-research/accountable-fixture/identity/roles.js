import { invariant } from "../core/errors.js";

const permissions = {
  viewer: new Set(["read"]),
  reviewer: new Set(["read", "comment"]),
  editor: new Set(["read", "comment", "write", "export", "invite"]),
  owner: new Set(["read", "comment", "write", "export", "invite", "settings"]),
};
export function permits(role, action) {
  return permissions[role]?.has(action) === true;
}
export function requireRole(membership, action) {
  invariant(membership && permits(membership.role, action), 403, "role_required", `Project permission ${action} is required`);
  return membership;
}
export function invitationRole(value) {
  invariant(["viewer", "reviewer", "editor"].includes(value), 400, "invalid_role", "Choose a supported invitation role");
  return value;
}
