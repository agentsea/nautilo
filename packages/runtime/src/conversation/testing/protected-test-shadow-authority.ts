import {
  __mintProtectedTestShadowAuthorityForTesting,
  type ProtectedTestShadowAuthority,
} from "../conversation-composition";

/**
 * Direct-source test harness only. This module is not exported from the
 * `@nautilo/runtime` package root.
 */
export function createProtectedTestShadowAuthorityForTests():
ProtectedTestShadowAuthority {
  return __mintProtectedTestShadowAuthorityForTesting();
}
