import { test } from "node:test";
import assert from "node:assert/strict";
import { application } from "./helpers.mjs";

test("project members preview documents and download prepared exports", () => {
  const { app, request } = application();
  assert.equal(request("mara", "GET", "/projects/atlas").status, 200);
  const preview = request("mara", "GET", "/projects/atlas/documents/atlas-plan");
  assert.equal(preview.body.title, "Launch plan");
  const accepted = request("mara", "POST", "/projects/atlas/exports", { documentIds: ["atlas-plan"] });
  assert.equal(app.runExport(accepted.body.jobId).state, "completed");
  const download = request("mara", "GET", `/exports/${accepted.body.jobId}/download`);
  assert.equal(download.body.documents.length, 1);
});

test("a completed upload appears in its selected project folder", () => {
  const { request, expiresAt } = application();
  const ticket = request("mara", "POST", "/projects/atlas/uploads", { filename: "review.md", expiresAt });
  const id = ticket.body.ticketId;
  assert.equal(request("mara", "PUT", `/uploads/${id}`, { content: "New review notes" }).status, 200);
  const completed = request("mara", "POST", `/projects/atlas/uploads/${id}/complete`, { folderId: "atlas-inbox" });
  const document = request("mara", "GET", `/projects/atlas/documents/${completed.body.documentId}`);
  assert.equal(document.body.body, "New review notes");
});

test("invitations are redeemed and selected documents can be shared", () => {
  const { app, request, expiresAt } = application();
  const invitation = request("mara", "POST", "/projects/atlas/invitations", { userId: "jo", role: "viewer", expiresAt });
  assert.equal(request("jo", "POST", "/invitations/redeem", { token: invitation.body.token }).status, 200);
  assert.equal(request("jo", "GET", "/projects/atlas/membership").body.role, "viewer");
  const share = request("mara", "POST", "/projects/atlas/shares", { documentIds: ["atlas-plan"], expiresAt });
  const response = app.dispatch({ method: "POST", path: "/shared/atlas-plan", body: share.body });
  assert.equal(response.body.title, "Launch plan");
});
