# Project document service

Small multi-project document API. Sessions are supplied by the trusted gateway.
The API serves documents directly or queues CSV exports that a worker prepares.
Only project members may read a project's documents; export downloads belong to
the requesting session user. The queue and result store are shared by users.

`api.mjs` is the request boundary, `policy.mjs` implements membership rules,
`store.mjs` is the in-memory storage adapter, and `worker.mjs` runs queued jobs.
`behavior.test.mjs` exercises the intended happy paths. The example is local-only
and contains synthetic data. It is not deployed.
