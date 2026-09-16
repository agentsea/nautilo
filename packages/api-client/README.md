# @nautilo/api-client

Typed HTTP client for the Nautilo server REST API. Used by every frontend app that talks to the backend.

## Usage

```typescript
import { NautiloApiClient } from "@nautilo/api-client";

const client = new NautiloApiClient("http://localhost:3001");
const response = await client.sendMessage({ message: "Hello" });
```

## What lives here

- `NautiloApiClient` class with typed methods matching server routes.
- Uses native `fetch()` — no extra HTTP library needed.
- Server URL is injected at construction (works for both local and cloud).

## Admin

`client.admin.users` exposes the D219 admin user-management surface:

- `list({ cursor?, limit?, includeFederated? })`
- `get(id)`
- `disable(id, reason?)`
- `enable(id)`
- `resetPassword(id)`

Promotion and demotion stay on the Groups API: use `client.groups.addMember` / `removeMember` when that namespace is available in the client.

## Who uses this

- `apps/mobile/` — React Native app.
- `apps/workbench/` — web workspace (Phase 2+).
