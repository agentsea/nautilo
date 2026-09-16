# Harbor review service

Harbor is a small collaboration service for teams reviewing documents in separate projects. An organization may contain several projects, but organization membership does not grant access to every project. The HTTP adapter accepts signed workspace sessions; project roles govern reading, editing, and exporting. Invitations are redeemed explicitly before membership becomes active.

The source is organized around workflows rather than a framework. `http/router.js` constructs an application, binds routes, and dispatches requests. `core/seed.js` provides development data. The backing store is an in-memory implementation of the repository interfaces; the service is deliberately runnable without a database or external network.

- `identity`: sessions, project membership, role checks, invitations and signed tokens.
- `projects`: access decisions, project overviews and settings.
- `documents`: document reads, previews, bundles and explicit share links.
- `jobs`: deferred exports, scheduled publication and download ownership.
- `uploads`: upload tickets, staging objects, folder placement and folder management.
- `events`: organization activity subscriptions and completion notifications.

Membership revocation applies to subsequent reads and to deferred work that has not executed. Documents and folders belong to exactly one project. An upload ticket identifies its submitting person and project; moving content between projects requires a separately authorized operation. A share link is a deliberate grant to named documents with an expiry. Organization activity is a coordination surface, not a grant to private project content. Completed exports are available to their requester while their underlying access remains valid.

`dispatch` accepts `{method, path, authorization, body}` and returns `{status, body}`. The route table is in `http/router.js`. Binary objects are represented as strings in this development adapter. No external gateway implementation is assumed. Production transport, persistence and deployment configuration are outside this package.

Run the happy-path suite with `npm test`. The package has no third-party runtime dependencies. Tests create isolated application state and do not open ports or access external accounts.
