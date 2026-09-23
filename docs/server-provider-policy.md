# Personal provider keys server policy

The server has one durable **Allow personal provider keys** switch. It is off
when a server is first installed or upgraded, including when the policy row has
not yet been written. The current value lives in the server database and is
read at admission time; it is not an environment or browser-local setting.

An administrator can inspect it in **Admin → Server**. A Human with
`manage_server_settings` can change it there; readers with
`read_server_settings` see the persisted value without an edit control. The
server enforces the same permissions on the API. An unsuccessful save leaves
the displayed persisted value intact and reports an error so the operator can
retry. The admin API is `GET /api/admin/server-provider-policy` and
`POST /api/admin/server-provider-policy` with the exact boolean body
`{"allowPersonalProviderKeys": true | false}`.

This switch is a release control, not a personal-key setup flow. In this
release, turning it on does not let a user save a provider key, select a
personal model, or run chat with personal funding. It does not add people to
Community or change existing server-funded calls. Leave it off on production
servers until a supported personal-key journey has been qualified. Use an
isolated test instance to verify the on/off state and restart persistence.

When later personal-funded operations are available, they must require both
this live server policy and the initiating Human's
`use_personal_provider_credentials` Capability. A missing row means off; an
unavailable policy store must not be treated as enabled. Turning the switch
off must never make a BYOK-only Human fall back to a server credential. A
database restore also restores the saved switch value, so inspect it before
opening a restored server to users.
