import type { AccessControlCatalogue } from "@nautilo/api-client";

type Group = AccessControlCatalogue["groups"][number];

export function groupCapabilityBundle(
  catalogue: AccessControlCatalogue,
  group: Group,
): readonly string[] {
  const rolesBySlug = new Map(
    catalogue.roles.map((role) => [role.slug, role.capabilitySlugs] as const),
  );
  return [
    ...new Set(
      group.roleSlugs.flatMap((roleSlug) => rolesBySlug.get(roleSlug) ?? []),
    ),
  ].sort();
}

export function missingGroupMembershipCapabilities(
  catalogue: AccessControlCatalogue,
  group: Group,
  viewerCapabilities: readonly string[],
): readonly string[] {
  const held = new Set(viewerCapabilities);
  return groupCapabilityBundle(catalogue, group).filter((slug) => !held.has(slug));
}

export function canManageGroupMembership(
  catalogue: AccessControlCatalogue,
  group: Group,
  viewerCapabilities: readonly string[],
): boolean {
  return viewerCapabilities.includes("manage_members")
    && missingGroupMembershipCapabilities(catalogue, group, viewerCapabilities).length === 0;
}
