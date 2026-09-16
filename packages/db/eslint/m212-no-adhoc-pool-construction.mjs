// @ts-check
import { ESLintUtils } from "@typescript-eslint/utils";
import {
  filenameToRepoRelative,
  loadValidatedAllowlist,
} from "./load-allowlist.mjs";

const createRule = ESLintUtils.RuleCreator(
  () =>
    "https://github.com/agentsea/nautilo-public/blob/main/packages/db/README.md",
);

const MARKER = "m212-no-adhoc-pool-construction";
const DIRECT_FACTORY_NAMES = new Set(["createDirectDb", "createDirectAgentDb"]);
const NAUTILO_DB_SOURCES = new Set(["@nautilo/db"]);

const { allowlist: ALLOWLIST } = loadValidatedAllowlist();

/**
 * @param {import("@typescript-eslint/utils").TSESTree.ImportDeclaration} node
 * @param {import("@typescript-eslint/utils").TSESTree.ImportClause | import("@typescript-eslint/utils").TSESTree.ImportSpecifier | import("@typescript-eslint/utils").TSESTree.ImportDefaultSpecifier | import("@typescript-eslint/utils").TSESTree.ImportNamespaceSpecifier} specifier
 */
function isTypeOnlySpecifier(node, specifier) {
  if (node.importKind === "type") return true;
  if ("importKind" in specifier && specifier.importKind === "type") return true;
  return false;
}

/**
 * @param {string | null | undefined} source
 */
function isPostgresModuleSource(source) {
  return source === "postgres";
}

/**
 * @param {string | null | undefined} source
 */
function isNautiloDbSource(source) {
  return typeof source === "string" && NAUTILO_DB_SOURCES.has(source);
}

/**
 * @param {import("@typescript-eslint/utils").TSESLint.RuleContext<string, []>} context
 */
function isAllowlistedFile(context) {
  const rel = filenameToRepoRelative(context.filename ?? context.getFilename());
  return ALLOWLIST.has(rel);
}

/**
 * @param {import("@typescript-eslint/utils").TSESLint.RuleContext<string, []>} context
 * @param {import("@typescript-eslint/utils").TSESTree.Node} node
 * @param {"directFactoryImport" | "directFactoryCall" | "postgresImport" | "postgresCall" | "directFactoryDynamicImport"} messageId
 * @param {Record<string, string>} [data]
 */
function report(context, node, messageId, data) {
  context.report({ node, messageId, data });
}

/**
 * @param {import("@typescript-eslint/utils").TSESTree.Identifier} identifier
 * @param {import("@typescript-eslint/utils").TSESLint.RuleContext<string, []>} context
 * @param {(def: import("@typescript-eslint/scope").VariableDef) => boolean} predicate
 */
function identifierMatchesDefinition(identifier, context, predicate) {
  const scope = context.sourceCode.getScope(identifier);
  const variable = scope.set.get(identifier.name);
  if (!variable) return false;
  return variable.defs.some(predicate);
}

/**
 * @param {import("@typescript-eslint/utils").TSESTree.Node | null | undefined} node
 */
function unwrapAwaitExpression(node) {
  if (!node) return null;
  if (node.type === "AwaitExpression") return node.argument;
  return node;
}

/**
 * @param {import("@typescript-eslint/utils").TSESTree.Node | null | undefined} node
 * @returns {string | null}
 */
function staticImportSource(node) {
  const unwrapped = unwrapAwaitExpression(node);
  if (!unwrapped) return null;
  if (unwrapped.type === "ImportExpression" && unwrapped.source.type === "Literal") {
    return typeof unwrapped.source.value === "string" ? unwrapped.source.value : null;
  }
  return null;
}

export const m212NoAdhocPoolConstruction = createRule({
  name: "m212-no-adhoc-pool-construction",
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid ad-hoc runtime postgres-js pool construction outside the M212 Phase 5 allowlist.",
    },
    schema: [],
    messages: {
      directFactoryImport:
        `[${MARKER}] Runtime import of \`{{name}}\` is forbidden outside the M212 pool-construction allowlist. ` +
        "Use the process-wide shared handle (`db`, `agentDb`, `getSharedDirectDb`, `getSharedDirectAgentDb`) or inject a caller-owned handle. " +
        "Type-only imports (`import type`) are permitted. See ISSUE-M212 Phase 5.",
      directFactoryCall:
        `[${MARKER}] Runtime call to \`{{name}}()\` is forbidden outside the M212 pool-construction allowlist. ` +
        "Use shared/injected DB handles instead of constructing a fresh pool. See ISSUE-M212 Phase 5.",
      postgresImport:
        `[${MARKER}] Runtime default import from \`postgres\` is forbidden outside the M212 pool-construction allowlist. ` +
        "Wire-protocol pools must be owned by `@nautilo/db` factories or explicit operator/bootstrap utilities. See ISSUE-M212 Phase 5.",
      postgresCall:
        `[${MARKER}] Runtime call to \`postgres(...)\` is forbidden outside the M212 pool-construction allowlist. ` +
        "Use shared/injected DB handles instead of constructing a fresh pool. See ISSUE-M212 Phase 5.",
      directFactoryDynamicImport:
        `[${MARKER}] Runtime dynamic import/destructure of \`{{name}}\` from \`@nautilo/db\` is forbidden outside the M212 pool-construction allowlist. ` +
        "Use shared/injected DB handles or a static allowlisted operator entrypoint. See ISSUE-M212 Phase 5.",
    },
  },
  defaultOptions: [],
  create(context) {
    if (isAllowlistedFile(context)) {
      return {};
    }

    /** Local bindings that alias a forbidden direct factory import. */
    /** @type {Set<string>} */
    const directFactoryBindings = new Set();
    /** Local bindings that alias a default `postgres` import. */
    /** @type {Set<string>} */
    const postgresBindings = new Set();

    return {
      ImportDeclaration(node) {
        if (node.importKind === "type") return;

        const source = node.source.type === "Literal" ? node.source.value : null;

        if (isPostgresModuleSource(source)) {
          for (const specifier of node.specifiers) {
            if (isTypeOnlySpecifier(node, specifier)) continue;
            if (specifier.type === "ImportDefaultSpecifier") {
              postgresBindings.add(specifier.local.name);
              report(context, specifier, "postgresImport");
            }
          }
        }

        for (const specifier of node.specifiers) {
          if (isTypeOnlySpecifier(node, specifier)) continue;
          if (specifier.type !== "ImportSpecifier") continue;

          const importedName =
            specifier.imported.type === "Identifier" ? specifier.imported.name : null;
          if (!importedName || !DIRECT_FACTORY_NAMES.has(importedName)) continue;

          directFactoryBindings.add(specifier.local.name);
          if (isNautiloDbSource(source) || typeof source === "string") {
            report(context, specifier, "directFactoryImport", { name: importedName });
          }
        }
      },

      VariableDeclarator(node) {
        if (node.id.type !== "ObjectPattern") return;
        const source = staticImportSource(node.init);
        if (!isNautiloDbSource(source)) return;

        for (const prop of node.id.properties) {
          if (prop.type !== "Property") continue;
          if (prop.key.type !== "Identifier") continue;
          if (!DIRECT_FACTORY_NAMES.has(prop.key.name)) continue;
          directFactoryBindings.add(prop.key.name);
          report(context, prop, "directFactoryDynamicImport", { name: prop.key.name });
        }
      },

      CallExpression(node) {
        const callee = node.callee;

        if (callee.type === "Identifier") {
          if (directFactoryBindings.has(callee.name)) {
            report(context, node, "directFactoryCall", { name: callee.name });
            return;
          }
          if (DIRECT_FACTORY_NAMES.has(callee.name)) {
            report(context, node, "directFactoryCall", { name: callee.name });
            return;
          }
          if (postgresBindings.has(callee.name)) {
            report(context, node, "postgresCall");
          }
          return;
        }

        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.property.type === "Identifier" &&
          DIRECT_FACTORY_NAMES.has(callee.property.name)
        ) {
          const memberName = callee.property.name;
          if (callee.object.type === "Identifier") {
            const objectName = callee.object.name;
            if (
              identifierMatchesDefinition(callee.object, context, (def) => {
                if (def.type !== "ImportBinding") return false;
                const parent = def.node.parent;
                return (
                  parent?.type === "ImportDeclaration" &&
                  isNautiloDbSource(
                    parent.source.type === "Literal" ? parent.source.value : null,
                  ) &&
                  def.node.type === "ImportNamespaceSpecifier"
                );
              })
            ) {
              report(context, node, "directFactoryCall", { name: memberName });
            }
          } else if (
            unwrapAwaitExpression(callee.object)?.type === "ImportExpression"
          ) {
            const source = staticImportSource(callee.object);
            if (isNautiloDbSource(source)) {
              report(context, node, "directFactoryCall", { name: memberName });
            }
          }
        }
      },
    };
  },
});
