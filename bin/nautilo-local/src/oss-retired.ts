const HINT = `\
\`bun run oss\` is retired for local dev setup.

Use:
  bun run infra:start -- --instance <id>
  bun run server:start -- --instance <id>
  bun run dev:setup -- --instance <id>
  NAUTILO_INSTANCE_ID=<id> bun run dev-stack --electron

Use infra:start + dev-stack as a minimal path.

The shared bootstrap code under bin/nautilo-local/ remains importable and is
still consumed by infra:start, server:start, and deployment tooling.
See playbook/operator/dev-mode-new-instance-setup.md for the M100 dev flow.
`;

process.stderr.write(HINT);
process.exit(2);
