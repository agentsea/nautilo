import type { DtoDeclaration } from "../src/node/dto-inventory";

export const SUPERSEDED_D565_RELAY_DTO_LOCATORS = new Set<string>([
  "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayDispatchRequest",
  "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayServerMessage",
  "relay:server_to_client:relay:dispatch",
  "relay:server_to_client:relay:error",
  "relay:server_to_client_arbitrary:packages/relay/src/protocol.ts#RelayDispatchMessage",
]);

const EXECUTION_CLASS_TO_IMPACT =
  "executionClass?:\"browser\"|\"computer_use\"|\"desktop\"|\"fs\"|\"local-file\"|\"real_workstation\"|\"structured-ssh\"|undefined;impact:";
const EXECUTION_CLASS_TO_HOST_AND_IMPACT =
  "executionClass?:\"browser\"|\"computer_use\"|\"desktop\"|\"fs\"|\"local-file\"|\"real_workstation\"|\"structured-ssh\"|undefined;hostedBy?:string|undefined;impact:";
const RELAY_ERROR_SHAPE = "{message:string;type:\"relay:error\"}";
const AUTHENTICATED_RELAY_ERROR_SHAPE =
  "{code?:typeof import(\"./constants\").RELAY_AUTHENTICATION_REQUIRED_ERROR_CODE;message:string;type:\"relay:error\"}";
const RELAY_CANCEL_BRANCH =
  "|{correlationId:string;type:\"relay:cancel\"}";

function replaceExactlyOnce(
  signature: string,
  before: string,
  after: string,
  locator: string,
): string {
  const first = signature.indexOf(before);
  const last = signature.lastIndexOf(before);
  if (first < 0 || first !== last) {
    throw new Error(
      `D565 DTO predecessor shape is absent or ambiguous for ${locator}`,
    );
  }
  return `${signature.slice(0, first)}${after}${signature.slice(first + before.length)}`;
}

function predecessor(
  declarations: readonly DtoDeclaration[],
  locator: string,
): DtoDeclaration {
  const declaration = declarations.find((candidate) =>
    candidate.locator === locator
  );
  if (declaration === undefined) {
    throw new Error(`D565 DTO predecessor is absent: ${locator}`);
  }
  return declaration;
}

function evolve(
  declarations: readonly DtoDeclaration[],
  locator: string,
  transforms: readonly ((signature: string, locator: string) => string)[],
): DtoDeclaration {
  const declaration = predecessor(declarations, locator);
  return {
    ...declaration,
    structuralSignatures: (declaration.structuralSignatures ?? []).map(
      (signature) => transforms.reduce(
        (current, transform) => transform(current, locator),
        signature,
      ),
    ),
  };
}

function addHostedBy(signature: string, locator: string): string {
  return replaceExactlyOnce(
    signature,
    EXECUTION_CLASS_TO_IMPACT,
    EXECUTION_CLASS_TO_HOST_AND_IMPACT,
    locator,
  );
}

function addAuthenticationErrorCode(signature: string, locator: string): string {
  return replaceExactlyOnce(
    signature,
    RELAY_ERROR_SHAPE,
    AUTHENTICATED_RELAY_ERROR_SHAPE,
    locator,
  );
}

function orderAuthenticationErrorBeforeCancel(
  signature: string,
  locator: string,
): string {
  const errorBranch = `|${AUTHENTICATED_RELAY_ERROR_SHAPE}`;
  const withoutError = replaceExactlyOnce(
    signature,
    errorBranch,
    "",
    locator,
  );
  return replaceExactlyOnce(
    withoutError,
    RELAY_CANCEL_BRANCH,
    `${errorBranch}${RELAY_CANCEL_BRANCH}`,
    locator,
  );
}

/**
 * Exact D565 Relay wire evolution. `hostedBy` selects a reviewed local adapter;
 * the optional error code lets clients distinguish a rejected unauthenticated
 * sidecar session without parsing provider prose.
 */
export function reviewedD565RelayDtoReplacements(
  declarations: readonly DtoDeclaration[],
): readonly DtoDeclaration[] {
  return [
    evolve(
      declarations,
      "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayDispatchRequest",
      [addHostedBy],
    ),
    evolve(
      declarations,
      "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayServerMessage",
      [
        addHostedBy,
        addAuthenticationErrorCode,
        orderAuthenticationErrorBeforeCancel,
      ],
    ),
    evolve(
      declarations,
      "relay:server_to_client:relay:dispatch",
      [addHostedBy],
    ),
    evolve(
      declarations,
      "relay:server_to_client:relay:error",
      [addAuthenticationErrorCode],
    ),
    evolve(
      declarations,
      "relay:server_to_client_arbitrary:packages/relay/src/protocol.ts#RelayDispatchMessage",
      [addHostedBy],
    ),
  ];
}
