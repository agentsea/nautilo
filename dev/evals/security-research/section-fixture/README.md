# Project document service

This synthetic local service shares one store and authorization cache across users.
A trusted upstream gateway supplies verified session user IDs. Its implementation
is external to this repository. Do not infer a gateway bypass from this assumption.

The repository has four sections: HTTP request handlers and export delivery in
packages/http, identity and membership decisions in packages/identity, the shared
storage adapter in packages/storage, and asynchronous export jobs in packages/jobs.
Inspect their cross-package boundaries as well as each section independently.

Only members may read project documents. Export creation accepts a selected project
and document ID. Downloaded exports must contain documents the requesting user is
currently allowed to read. Membership revocation must invalidate cached grants and
prevent queued exports from disclosing the former project's documents. A queued job
is work to validate, not a perpetual grant. Preview uses a fresh membership check;
export download additionally checks ownership of the job.

The project has no external dependencies and is not deployed. Tests show ordinary
allowed behavior and selected denials; they are not evidence that every combination
of identities, document IDs, cache states and queue transitions is correct.
