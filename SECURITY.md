# Security policy

## Reporting a vulnerability

Email **[security-reports@kentauros.ai](mailto:security-reports@kentauros.ai?subject=Nautilo%20security%20report)**
to report a suspected vulnerability privately to the Nautilo maintainers.
We will reply by email to investigate and coordinate a fix. Do not open a public
GitHub issue or pull request with exploit details.

The [reporting page](https://nautilo.ai/security) also explains what to include.

Include the smallest useful reproduction, affected version or commit, impact,
and redacted diagnostics. Do not include real credentials, access tokens,
private conversation content, customer data, recovery material, signing keys,
or complete configuration files.

For general security guidance and self-hosting hardening, see the
[security documentation](https://nautilo.ai/docs/security) and
[operator hardening guide](https://nautilo.ai/docs/operator/security-hardening).

## Ordinary bugs

For a bug that does not expose sensitive information or enable unauthorized access,
[file a bug report](https://github.com/agentsea/nautilo/issues/new?template=01-reproducible-defect.yml).
If you cannot access the repository,
[email a bug report](mailto:security-reports@kentauros.ai?subject=Nautilo%20bug%20report).
Include your version, operating system, and steps to reproduce the problem.

## Supported versions

Security fixes are made on the current development line and included in new
release versions. The current public release status and supported artifacts are
listed at [nautilo.ai/product-release-status](https://nautilo.ai/product-release-status).

Do not assume an older Desktop, CLI, server, bootstrap, or deployment artifact
receives fixes indefinitely. Upgrade to the latest supported release before
reporting a defect that has already been corrected there.

## Public discussion

After maintainers confirm that disclosure is safe, follow-up fixes and public
discussion may use the normal contribution process in
[`CONTRIBUTING.md`](CONTRIBUTING.md). Until then, keep all exploit details and
sensitive evidence in the private reporting channel.
