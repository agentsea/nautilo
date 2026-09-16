export function seedDevelopment(store) {
  store.organizations.put({ id: "north", name: "North Studio" });
  store.users.put({ id: "mara", organizationIds: ["north"], active: true, name: "Mara" });
  store.users.put({ id: "eli", organizationIds: ["north"], active: true, name: "Eli" });
  store.users.put({ id: "jo", organizationIds: ["north"], active: true, name: "Jo" });
  store.projects.put({ id: "atlas", organizationId: "north", name: "Atlas", archived: false, revision: 1 });
  store.projects.put({ id: "cedar", organizationId: "north", name: "Cedar", archived: false, revision: 1 });
  store.memberships.put({ projectId: "atlas", userId: "mara", role: "editor", state: "active", revision: 1 });
  store.memberships.put({ projectId: "atlas", userId: "eli", role: "viewer", state: "active", revision: 1 });
  store.memberships.put({ projectId: "cedar", userId: "jo", role: "editor", state: "active", revision: 1 });
  store.folders.put({ id: "atlas-inbox", projectId: "atlas", name: "Inbox", archived: false });
  store.folders.put({ id: "cedar-inbox", projectId: "cedar", name: "Inbox", archived: false });
  store.documents.put({ id: "atlas-plan", projectId: "atlas", folderId: "atlas-inbox", title: "Launch plan", body: "Atlas launch costs are 410 credits.", revision: 1, visibility: "project" });
  store.documents.put({ id: "atlas-notes", projectId: "atlas", folderId: "atlas-inbox", title: "Review notes", body: "Assign the checklist to the design team.", revision: 1, visibility: "project" });
  store.documents.put({ id: "cedar-plan", projectId: "cedar", folderId: "cedar-inbox", title: "Supplier terms", body: "Cedar supplier rebate is 37 percent.", revision: 1, visibility: "project" });
}
