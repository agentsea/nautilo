import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import nautiloDbGuard from './packages/db/eslint/index.mjs';
import nautiloMessageInvariants from './packages/message-invariants/eslint/index.mjs';

// D060 Sprint 1 G5.6 (ship plan v3 §5.6) — `no-policy-env-var` rule.
// These environment variables were deleted from the codebase in
// Sprint 1 because, in an open-source release build, any policy-
// affecting env var is a bypass surface (a prompt-injected agent
// socially engineering the user into unsetting one turns the
// sandbox off silently). The runtime G5.6 part 2 panic closes the
// test-mode var surface; this lint rule closes the reintroduction
// surface by banning reads of any of these names going forward.
//
// If you want to add a NEW policy-affecting knob, do it via the
// Server posture API (`PUT /api/security/posture`) + the
// `manage_server_security` Capability, NOT an env var. See
// security-ship-plan-2026-04.md for the rationale.
//
// Test-mode vars (NAUTILO_TEST_MODE*, NAUTILO_TEST_TOKEN) are NOT
// on this list — they are allowed in `test-mode-guard.ts` and the
// server boot path, gated by the production-build panic.
const BANNED_POLICY_ENV_VARS = [
  'NAUTILO_SECURITY_LEVEL',
  'NAUTILO_SANDBOX_RELAY',
  'NAUTILO_DEPLOYMENT',
  'NAUTILO_TLS',
];

// Build access-path selectors for each banned var. ESLint's
// `no-restricted-syntax` takes a single selector per entry, so we
// emit one entry per (var, access-style) pair covering FIVE bypass
// shapes (the first two are the obvious direct-on-process.env
// patterns; the last three are the PR-017 MINOR #3 hardenings that
// close the destructure / alias / Reflect escape routes):
//
//   1) process.env["FOO"]                  — bracket access
//   2) process.env.FOO                     — dot access
//   3) const { FOO } = process.env         — destructure on process.env
//   4) const { FOO } = <alias-of-process.env>
//      + <alias>["FOO"] / <alias>.FOO      — indirect via a local binding
//   5) Reflect.get(process.env, "FOO")     — reflective escape
//
// (3) and (5) have dedicated selectors below; (4) is harder — the
// lint rule can't follow arbitrary aliasing without a full scope
// analyzer, so the defense is layered: the red-team script
// (`ops/security/red-team-env-var.sh`) greps production source for bare
// string occurrences of each banned name regardless of access
// style, and the G5.6 runtime panic catches any slip-through at
// boot for test-mode vars. For policy vars specifically, the
// combination of (1)+(2)+(3)+(5) covers every bypass pattern
// current codebase audits have surfaced; (4) remains an open
// defense-in-depth gap tracked as a nit in the D060 Sprint 1
// follow-ups file.
// M127 — Memory/Artifact namespace-only boundary guard.
//
// After M127, `memories` and `artifacts` no longer carry an `agent_id`
// column. Namespace membership is the sole content-scope axis. The ESLint
// rules below flag the three most likely regression shapes:
//
//   1) `memories.agentId` / `artifacts.agentId` property access  (Drizzle column read)
//   2) Object-literal properties named `agentId` directly nested inside a
//      `.where(...)` / `.values(...)` / `.select(...)` call where the
//      member chain begins with `memories` or `artifacts`
//   3) Raw SQL template strings (or tagged sql\`...\`) containing the
//      regex `(memories|artifacts)\.agent_id`
//
// Allowlist (carved out by file-level `ignores`):
//   - packages/db/src/migrations/**          (frozen historical SQL)
//   - packages/db/src/schema/artifact-state.ts + queries/artifact-state.ts
//     (D121 interactive HTML state — keeps agent_id by design)
//   - **/__lint_fixtures__/**                (deliberate-violation fixtures)
//
// `MemoryAccessEnvelope.agentId` is unaffected — it's still threaded
// everywhere for AgentScope + trust-context routing; only the row tables
// dropped the column. See ISSUE-M127 + Common Mistake #28 in README.ai.
const m127MemoryArtifactColumnRestrictions = [
  {
    selector:
      "MemberExpression[object.type='Identifier'][object.name='memories'][property.name='agentId']",
    message:
      "[m127-no-agent-id-on-memory-or-artifact] `memories.agentId` was dropped in M127 — " +
      "Namespace is the sole content-scope axis. Use `memory_namespaces` overlap instead. " +
      "If you need AgentScope isolation use `memory_scopes` + `agent_scopes`. " +
      "See ISSUE-M127 + Common Mistake #28 in README.ai.",
  },
  {
    selector:
      "MemberExpression[object.type='Identifier'][object.name='artifacts'][property.name='agentId']",
    message:
      "[m127-no-agent-id-on-memory-or-artifact] `artifacts.agentId` was dropped in M127 — " +
      "Namespace is the sole content-scope axis. Use `artifact_namespaces` overlap instead. " +
      "`file_revisions.agent_id` and `artifact_state.agent_id` keep per-agent scoping by design — " +
      "those tables are unrelated. See ISSUE-M127 + Common Mistake #28 in README.ai.",
  },
  {
    // Raw SQL escape hatch: any template element containing `memories.agent_id`
    // or `artifacts.agent_id` literally. Catches `sql\`... memories.agent_id ...\``
    // and plain template strings used with `handle.execute(sql\`...\`)`.
    selector:
      "TemplateElement[value.raw=/(memories|artifacts)\\.agent_id/]",
    message:
      "[m127-no-agent-id-on-memory-or-artifact] Raw SQL references to `memories.agent_id` " +
      "or `artifacts.agent_id` are forbidden after M127 — the column is gone. " +
      "Predicate by namespace membership (`memory_namespaces` / `artifact_namespaces`) " +
      "or by `memory_scopes` for AgentScope. See ISSUE-M127.",
  },
];

const policyEnvRestrictions = BANNED_POLICY_ENV_VARS.flatMap((name) => [
  {
    // (1) Bracket access: process.env["FOO"]
    selector: `MemberExpression[object.type='MemberExpression'][object.object.name='process'][object.property.name='env'][property.type='Literal'][property.value='${name}']`,
    message:
      `[no-policy-env-var] Reading process.env["${name}"] is forbidden — ` +
      `policy-affecting env vars were deleted in D060 Sprint 1 G5.6 to ` +
      `remove the open-source bypass surface. Use the Server posture API ` +
      `(PUT /api/security/posture) + manage_server_security Capability ` +
      `instead; environment variables cannot override server security policy.`,
  },
  {
    // (2) Dot access: process.env.FOO
    selector: `MemberExpression[object.type='MemberExpression'][object.object.name='process'][object.property.name='env'][property.type='Identifier'][property.name='${name}']`,
    message:
      `[no-policy-env-var] Reading process.env.${name} is forbidden — ` +
      `policy-affecting env vars were deleted in D060 Sprint 1 G5.6. Use ` +
      `the Server posture API instead. See security-ship-plan-2026-04.md §5.6.`,
  },
  {
    // (3) Destructure: const { FOO } = process.env
    // Matches the Property node inside an ObjectPattern (destructure
    // target) whose init chain is `process.env`. Identifier key named
    // exactly `${name}`.
    selector: `ObjectPattern > Property[key.type='Identifier'][key.name='${name}']:has(~ * ObjectPattern):not([computed=true])`,
    message:
      `[no-policy-env-var] Destructuring \`${name}\` from process.env is forbidden — ` +
      `policy-affecting env vars were deleted in D060 Sprint 1 G5.6. Renaming ` +
      `via destructure is not an escape hatch. See security-ship-plan-2026-04.md §5.6.`,
  },
  {
    // (3-alt) Simpler destructure matcher that catches `{ FOO } = process.env`
    // directly; the :has selector above can miss on certain parser AST
    // shapes, so we emit a belt-and-suspenders rule that catches any
    // VariableDeclarator whose id is an ObjectPattern with a property
    // whose key name matches AND whose init is `process.env`.
    selector: `VariableDeclarator[init.type='MemberExpression'][init.object.name='process'][init.property.name='env'] > ObjectPattern > Property[key.type='Identifier'][key.name='${name}']`,
    message:
      `[no-policy-env-var] Destructuring \`${name}\` from process.env is forbidden — ` +
      `policy-affecting env vars were deleted in D060 Sprint 1 G5.6. See ` +
      `security-ship-plan-2026-04.md §5.6.`,
  },
  {
    // (5) Reflective escape: Reflect.get(process.env, "FOO")
    selector: `CallExpression[callee.type='MemberExpression'][callee.object.name='Reflect'][callee.property.name='get'][arguments.0.type='MemberExpression'][arguments.0.object.name='process'][arguments.0.property.name='env'][arguments.1.type='Literal'][arguments.1.value='${name}']`,
    message:
      `[no-policy-env-var] Reflect.get(process.env, "${name}") is forbidden — ` +
      `reflective env reads don't bypass the D060 Sprint 1 G5.6 ban. Use the ` +
      `Server posture API instead. See security-ship-plan-2026-04.md §5.6.`,
  },
]);

/** D126 Phase 0 — reused by root + agent-tool `no-restricted-imports` blocks */
const D126_NO_DEEP_LOGTO_IMPORT_PATTERNS = [
  {
    group: ['@logto/react/lib', '@logto/react/lib/**', '@logto/react/lib/*'],
    message:
      '[d126-no-deep-logto] Deep imports into @logto/react are forbidden. ' +
      'They break Vite\'s single-module-instance invariant and bind us to ' +
      '@logto/react\'s private API surface. Use package-root imports only: ' +
      "import { ... } from '@logto/react'. See ISSUE-D126 Phase 0.",
  },
  {
    group: ['**/node_modules/@logto/**'],
    message:
      '[d126-no-deep-logto] Reaching into node_modules/@logto/* via relative ' +
      'paths is forbidden for the same reason as the @logto/react/lib ban. ' +
      'Use package-root imports only. See ISSUE-D126 Phase 0.',
  },
];

export default tseslint.config(
  {
    ignores: [
      // Source-generated Ajv output is verified by office-slides check:model-schema.
      'packages/first-party-apps/presentation/src/generated/native-slide-model-validator.mjs',
      'packages/first-party-apps/board/src/generated/native-board-model-validator.mjs',
      'packages/db/eslint/',
      '**/packages/db/eslint/',
      // The Computer Use Host owns a source-only TypeScript project. Its
      // package config intentionally excludes Bun parity/live tests; keep the
      // root staged-file hook consistent with that package boundary.
      'packages/computer-use-host/tests/**',
      // M221: wasm-pack output is reviewed and hash-verified generated vendor
      // code. Lint the handwritten wrapper and verifier, not generated glue.
      'packages/lattice-crypto/vendor/openmls-wasm/**',
      // M225: Stryker sandboxes and retained assurance reports are generated
      // evidence. Lint their tracked source inputs, never the copied output.
      'packages/lattice-crypto/.stryker-tmp/**',
      'packages/lattice-crypto/reports/**',
      // ANTLR output is regenerated from Formula.g4; lint handwritten engine
      // source and the generator script, not generated parser implementation.
      'packages/office-sheets/antlr/*.ts',
      // The app receives verified compiled workspace output during assembly.
      'packages/first-party-apps/spreadsheet/engine/**',
      'packages/first-party-apps/presentation/engine/**',
      'packages/first-party-apps/board/engine/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      'no-restricted-syntax': [
        'error',
        ...policyEnvRestrictions,
        ...m127MemoryArtifactColumnRestrictions,
      ],
      // ISSUE-D126 Phase 0
      'no-restricted-imports': ['error', {
        patterns: D126_NO_DEEP_LOGTO_IMPORT_PATTERNS,
      }],
    },
  },

  // The isolated Wafflebase packaging recipe is ordinary Node ESM. Keep
  // JavaScript correctness linting enabled while avoiding TypeScript's
  // type-aware rules for the adjacent checkJs:false project.
  {
    files: ['packaging/wafflebase/*.mjs', 'packages/first-party-apps/board/scripts/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
  },

  // The Share Extension config plugin is handwritten production Node code.
  // It is intentionally outside apps/mobile/tsconfig.json because Expo loads
  // it while generating native projects. Its adjacent plugins/tsconfig.json
  // gives projectService a real checked-JavaScript project instead of excluding
  // this production file or muting its unsafe-value rules.
  {
    files: [
      'apps/mobile/plugins/with-nautilo-share-extension.js',
      'apps/mobile/plugins/with-nautilo-ios-local-network.js',
      'apps/mobile/plugins/with-nautilo-media-export.js',
    ],
    languageOptions: {
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Expo discovers this Node config plugin through `require()`, while its
      // Xcode project dependency has no TypeScript declarations. Keep the
      // CommonJS compatibility exception exact to this loader file; explicit
      // PBX boundary contracts keep the vendor values type-checked below.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // ISSUE-D129 Phase 4 + Phase 3 part 2 — forbid full-privilege `db`
  // singleton in agent tools, store, notifications.
  //
  // SCOPE: full agent surface (post-D129-P3-part-2 refactor on 2026-05-19).
  // 15 files were swapped from `import { db, ... }` to
  // `import { agentDb as db, ... }`; the lint rule now enforces the
  // contract going forward. The `__lint_fixtures__` deliberate-violation
  // fixture is excluded by the global `ignores` block below so the main
  // lint pass doesn't trip on the intentional violation.
  //
  // Tool files in `packages/agent/src/tools/` that need full-privilege
  // access for narrow, audited purposes (e.g. `tools/trust/verify-identity.ts`
  // which reads `credentials` for PIN verification) currently use
  // `createDirectDb()` directly — NOT the `db` singleton — and therefore
  // do not trigger this rule. D168 P3's credentials-chokepoint refactor
  // will move those call sites behind `verifyPinCredential` /
  // `verifyPasskeyCredential` helpers that internally use the
  // full-privilege handle.
  {
    files: [
      // M033 Phase 6 — guard widened from `tools/store/notifications` to ALL of
      // `packages/agent/src/**` (every file reachable from the LangGraph
      // runtime). The `ignores` list below carves out the legitimate exceptions.
      'packages/agent/src/**/*.ts',
      'src/tools/**/*.ts',
      'src/store/**/*.ts',
      'src/notifications/**/*.ts',
    ],
    ignores: [
      // LangGraph `PostgresSaver` requires a wire-protocol connection string;
      // the library owns its own pool. See top-of-file doc comment.
      'packages/agent/src/checkpoints/checkpoint-saver.ts',
      // Deliberate violation fixture for the lint rule itself.
      'packages/agent/src/tools/__lint_fixtures__/**',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: D126_NO_DEEP_LOGTO_IMPORT_PATTERNS,
        paths: [
          {
            name: '@nautilo/db',
            importNames: ['db'],
            message:
              '[d129-no-fullpriv-db-in-tools] The full-privilege `db` singleton from `@nautilo/db` must not be imported anywhere under `packages/agent/src/**`. ' +
              'Use `agentDb`, `createAgentDatabase()`, `createDirectAgentDb()`, schema re-exports (e.g. `memories`, `users`), or Drizzle helpers (`eq`, `sql`, …). ' +
              'See ISSUE-D129 Phase 3–4 + ISSUE-M033 Phase 6 and `packages/db/src/index.ts` exports.',
          },
          {
            name: '@nautilo/db',
            importNames: ['createDirectDb'],
            message:
              '[d168-no-createDirectDb-in-agent] `createDirectDb` returns a postgres-js Drizzle handle connected as the `nautilo` SUPERUSER (BYPASSRLS = true). ' +
              'In the agent surface this would bypass D129 P3 role grants AND D168 P2 Path C RLS in a single import. ' +
              'Use `agentDb` / `createAgentDatabase()` / `createDirectAgentDb()` instead (restricted role; RLS-policy-enforced; no GRANT on credentials/recovery_codes). ' +
              'If you genuinely need credential access from agent code, route through `PinChallengeProvider` from `@nautilo/trust`. ' +
              'See ISSUE-D168 Phase 3 + `agent-role-isolation.integration.test.ts` for the threat model.',
          },
        ],
      }],
    },
  },

  // ---------------------------------------------------------------------
  // D168 P3 — credentials chokepoint
  // ---------------------------------------------------------------------
  //
  // `credentials` + `recoveryCodes` schema exports from `@nautilo/db`
  // may only be imported from:
  //   - `packages/trust/src/challenge.ts` (PinChallengeProvider — the
  //     chokepoint)
  //   - `bin/nautilo-reset-pin/**` (operator CLI; superuser by design)
  //   - integration tests + ESLint fixtures (test scaffolding needs
  //     direct schema access for seeding/cleanup)
  //
  // Everywhere else, route PIN/recovery-code reads through
  // `PinChallengeProvider` (or future recovery-code chokepoint
  // sibling). FORCE-RLS-on-credentials in migration #48 makes naked
  // direct queries fail-closed at runtime (0 rows when GUC absent),
  // so this lint is a static-time tripwire on top of the runtime
  // fail-closed.
  //
  // Scope = everywhere; allow-list is expressed by EXCLUDING the
  // allow-listed paths via `ignores` in this block.
  {
    files: ['**/*.{ts,tsx}'],
    ignores: [
      // Allow-list: only these files may import `credentials` /
      // `recoveryCodes` schema exports from `@nautilo/db`.
      '**/packages/trust/src/challenge.ts',       // PinChallengeProvider — credentials chokepoint
      '**/packages/trust/src/recovery-codes.ts',  // recovery-codes chokepoint
      '**/packages/trust/src/**/__tests__/**',
      '**/packages/trust/tests/**',
      '**/bin/nautilo-reset-pin/**',              // operator CLI; superuser by design
      '**/bin/nautilo-dev/**',                    // operator/dev CLI; superuser by design
      '**/packages/server/src/lib/redeem-invite.ts', // invite-redemption tx owns its own GUC
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.integration.test.ts',
      '**/__lint_fixtures__/**',
      '**/tests/**',
      'packages/db/src/**',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          {
            name: '@nautilo/db',
            importNames: ['credentials', 'recoveryCodes'],
            message:
              '[d168-credentials-chokepoint] Direct imports of `credentials` / `recoveryCodes` schema exports are restricted to the chokepoint module `packages/trust/src/challenge.ts` (PinChallengeProvider) and operator-only CLIs (`bin/nautilo-reset-pin/`, `bin/nautilo-dev/`). ' +
              'Everywhere else: use `PinChallengeProvider.isEnrolled()` / `.verifyProof()` / `.enroll()` / `.changePin()` from `@nautilo/trust`. ' +
              'See ISSUE-D168 Phase 3 + migration `0051_d168_p3_force_rls_credentials.sql`.',
          },
        ],
      }],
    },
  },

  // ---------------------------------------------------------------------
  // M125 Phase 3 — bootstrap-state-cache chokepoint
  // ---------------------------------------------------------------------
  //
  // `getBootstrapDefaultAgentId` and `getBootstrapOwnerId` from
  // `@nautilo/trust` may only be imported from operator surfaces
  // (`bin/nautilo-server`, `bin/nautilo-dev`, `bin/nautilo-reset-pin`),
  // the trust package itself (the getters live there), and a small
  // set of test scaffolding files. Everywhere else they're a
  // single-tenant footgun: pre-M125 every read silently dressed
  // non-operator requests in the first claimer's identity (cross-user
  // wrong-agent attribution + memory partition risk).
  //
  // New production callers must derive `agentId` from
  // `request.memoryEnvelope?.agentId` (per-call) or
  // `findAgentsOwnedByUser(userId)` (per-user) and fail-closed when
  // missing. See ISSUE-M125 + Common Mistake #27 in README.ai.
  {
    files: ['**/*.{ts,tsx}'],
    ignores: [
      // Allow-list: only these paths may import the bootstrap-state-cache
      // getters. Everything else must derive ids from request context.
      '**/packages/trust/src/**',                 // the getters live here
      '**/bin/nautilo-server/**',                 // boot wiring
      '**/bin/nautilo-dev/**',                    // operator surfaces (doctor cmds)
      '**/bin/nautilo-reset-pin/**',              // operator CLI
      '**/bin/nautilo-local/**',                  // local-mode wrapper
      '**/packages/server/tests/integration/helpers/app-fixture.ts', // test harness convenience
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.integration.test.ts',
      '**/tests/**',
      '**/__lint_fixtures__/**',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          {
            name: '@nautilo/trust',
            importNames: ['getBootstrapDefaultAgentId', 'getBootstrapOwnerId'],
            message:
              '[m125-no-bootstrap-state-cache-in-request-paths] ' +
              '`getBootstrapDefaultAgentId` / `getBootstrapOwnerId` from `@nautilo/trust` are operator-scoped only. ' +
              'Pre-M125 production routes used them as fallbacks, which silently attributed non-operator requests to the first claimer\'s identity. ' +
              'Derive `agentId` from `request.memoryEnvelope?.agentId` (per-call) or `findAgentsOwnedByUser(userId)` (per-user); fail closed with `400 no_agent_in_context` when neither resolves. ' +
              'See ISSUE-M125 + Common Mistake #27 in README.ai.',
          },
        ],
      }],
    },
  },

  // ---------------------------------------------------------------------
  // ISSUE-M212 Phase 5 — ad-hoc postgres-js pool construction guard
  // ---------------------------------------------------------------------
  //
  // Forbid runtime imports/calls of `createDirectDb`, `createDirectAgentDb`,
  // and default `postgres(...)` outside the documented allowlist in
  // `packages/db/eslint/m212-pool-construction-allowlist.json`.
  // `import type` remains permitted; comments/strings never match (AST-only).
  {
    files: ['**/*.{ts,tsx}'],
    ignores: [
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.integration.test.ts',
      '**/tests/**',
      '**/__lint_fixtures__/**',
    ],
    plugins: {
      '@nautilo/db': nautiloDbGuard,
    },
    rules: {
      '@nautilo/db/m212-no-adhoc-pool-construction': 'error',
    },
  },

  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'nautilo-msg': nautiloMessageInvariants,
    },
    rules: {
      'nautilo-msg/no-naked-message-concat': 'error',
      // ISSUE-M171 (Phase H) — forbid checkpoint-history reads
      // (`getState(...).values.messages` as conversation history). The DB
      // transcript is the single source of truth; the checkpoint is in-flight
      // execution state only. Legitimate resume / output-extraction reads are
      // allowlisted in the block below.
      'nautilo-msg/no-checkpoint-history-read': 'error',
    },
  },

  // ---------------------------------------------------------------------
  // ISSUE-M171 (Phase H) R8 — `no-checkpoint-history-read` allowlist
  // ---------------------------------------------------------------------
  //
  // The checkpoint is STILL written + read for mid-turn resume and subagent
  // OUTPUT EXTRACTION (R6/R8); only history-rebuild reads were removed. These
  // files hold the legitimate remaining `.values.messages` reads:
  //   - scope-subagent/run.ts        — subagent final-text output extraction
  //   - resume-human-reply.ts        — await_human_reply final-text output
  //   - resume-approval.ts /
  //     inspect-resume-outcome.ts    — resume-outcome message-list inspection
  //   - security/research-export.ts — finalized report output extraction only;
  //     canonical messages are never changed or supplied as model history.
  // Test files + lint fixtures also assert on raw checkpoint shape. Mirrors the
  // m125 / d168 file-glob allowlist pattern (allow by EXCLUSION via `files`).
  {
    // NOTE: per-package `eslint .` runs with cwd at the package root, so flat-
    // config `files` globs resolve relative to the PACKAGE (e.g.
    // `src/graph/resume-human-reply.ts`), not the repo root. Use trailing-path
    // globs (`**/<unique-tail>`) so they match whether cwd is the repo root or
    // the package.
    files: [
      '**/subagents/scope-subagent/run.ts',
      '**/graph/resume-human-reply.ts',
      '**/graph/resume-approval.ts',
      '**/graph/inspect-resume-outcome.ts',
      '**/tools/security/research-export.ts',
      '**/*.test.{ts,tsx,js,mjs,cjs}',
      '**/__tests__/**/*.{ts,tsx,js,mjs,cjs}',
      '**/tests/**',
      '**/__lint_fixtures__/**',
    ],
    plugins: {
      'nautilo-msg': nautiloMessageInvariants,
    },
    rules: {
      'nautilo-msg/no-checkpoint-history-read': 'off',
    },
  },

  {
    files: ['**/*.test.{ts,tsx,js,mjs,cjs}', '**/__tests__/**/*.{ts,tsx,js,mjs,cjs}'],
    languageOptions: {
      globals: {
        test: true,
        describe: true,
        it: true,
        beforeEach: true,
        afterEach: true,
        beforeAll: true,
        afterAll: true,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
      'no-console': 'off',
    },
  },

  {
    // The blind-audit corpora is preserved as the exact untyped JavaScript
    // bytes the live model reviewed. Keep ordinary JS lint; do not require a
    // TypeScript API contract that would change the measured fixture.
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { ...tseslint.configs.disableTypeChecked.languageOptions, globals: { structuredClone: 'readonly', Buffer: 'readonly' } },
    files: ['dev/evals/security-research/fixture/*.mjs', 'dev/evals/security-research/oracle.test.mjs',
      'dev/evals/security-research/section-fixture/**/*.mjs', 'dev/evals/security-research/accountable-fixture/**/*.{js,mjs}', 'dev/evals/security-research/accountable-oracle.test.mjs', 'dev/evals/security-research/section-oracle.test.mjs'],
  },

  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/build/**',
      '**/migrations/**',
      '**/docker/**',
      '**/*.config.js',
      '**/*.config.ts',
      '**/*.config.mjs',
      'bun.lock',
      // Workbench's package config deliberately excludes co-located src tests,
      // and this standalone generator test has no TypeScript project. Mirror
      // those exact exclusions when the root pre-commit hook passes staged
      // paths explicitly; apps/workbench/tests has its own checked project.
      'apps/workbench/src/**/*.test.ts',
      'apps/workbench/src/**/*.test.tsx',
      // Writer's package-owned Bun tests are exercised by `bun test` and are
      // intentionally outside its production-only TypeScript checkpoint.
      // Keep the root staged-file hook aligned with that package boundary.
      'packages/first-party-apps/writer/src/**/*.test.ts',
      'packages/first-party-apps/writer/src/**/*.test.tsx',
      // Runtime smoke harness: exercised directly by Desktop CI and its
      // adjacent unit contract; it is intentionally outside Desktop's
      // Electron-only TypeScript project.
      'apps/desktop/scripts/smoke-packaged.ts',
      // Desktop's package-local lint config excludes build scripts because
      // they are outside its Electron-only TypeScript project. Mirror that
      // exact exclusion when the root pre-commit hook receives this CommonJS
      // after-pack hook as an explicit staged path.
      'apps/desktop/scripts/after-pack.cjs',
      // The sibling after-sign hook is exercised by Desktop packaging tests;
      // like after-pack it is package-local CommonJS outside a TS project.
      'apps/desktop/scripts/after-sign.cjs',
      // This DOM test uses the unit-isolated Bun harness, which is outside the
      // Workbench projectService program but is typechecked by its focused run.
      'apps/workbench/tests/unit-isolated/startup-section.test.tsx',
      'apps/workbench/tests/unit-isolated/encrypted-recovery-section.test.tsx',
      // Root mobile preflight contract is executed directly by Bun and is not
      // part of a TypeScript projectService program. Keep staged-file linting
      // aligned with that existing test boundary.
      'scripts/mobile-local-preflight.test.ts',
      // Executable smoke script is checked by its packaged-surface Bun test;
      // Desktop's TypeScript project does not include the scripts directory.
      'apps/desktop/scripts/smoke-packaged.ts',
      // This pre-existing source-contract test intentionally awaits a mocked
      // clock callback; its focused Bun run is the authoritative check.
      'apps/desktop/tests/unit/packaged-preload-surface.test.ts',
      'dev/tests/application-catalogue-generation.test.ts',
      'dev/tests/repo-invariants/encryption-wave0-wiring.test.ts',
      'dev/tests/repo-invariants/m281-actions-cost-control.test.ts',
      'dev/tests/repo-invariants/lattice-bridge-storage.test.ts',
      'dev/tests/repo-invariants/lattice-crypto-import.test.ts',
      // Co-located test files under `src/modes/rooms/<feature>/tests/` are
      // excluded from `apps/workbench/tsconfig.json`; ESLint projectService
      // cannot attach a TS program to them. The wildcard covers thread-drawer,
      // typing, and any future feature that follows the same co-located
      // pattern. Tests at `apps/workbench/tests/` ARE in tsconfig and lint.
      'apps/workbench/src/modes/rooms/*/tests/**',
      'packages/message-invariants/eslint/**',
      'packages/db/eslint/',
      '**/packages/db/eslint/',
      '**/packages/db/eslint/**',
      // D129 P4 — deliberate-violation fixtures are eslint-against-on-purpose
      // from a hermetic test; the main lint pass MUST ignore them or the
      // rule's own fixture trips it.
      '**/__lint_fixtures__/**',
    ],
  }
);
