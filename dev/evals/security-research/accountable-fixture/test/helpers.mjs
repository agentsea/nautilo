import { randomBytes } from "node:crypto";
import { createApplication } from "../http/router.js";

export function application() {
  const now = Date.UTC(2026, 0, 12);
  const app = createApplication({ secret: randomBytes(32).toString("hex"), now });
  const expiresAt = now + 60 * 60 * 1000;
  const request = (userId, method, path, body) => app.dispatch({ method, path, body,
    authorization: `Bearer ${app.session(userId, expiresAt)}` });
  return { app, request, expiresAt };
}
