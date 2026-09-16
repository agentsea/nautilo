import {
  createBackgroundAuthorizationResponseV1,
  type CreatedBackgroundAuthorizationResponseV1,
} from "../../src/background/background-authorization-response-v1.ts";
import {
  createProcessorCredentialFixtureV1,
  type ProcessorCredentialFixtureV1,
} from "./processor-credential-v1-fixture.ts";

export interface BackgroundAuthorizationResponseFixtureV1
  extends ProcessorCredentialFixtureV1 {
  readonly response: CreatedBackgroundAuthorizationResponseV1;
}

export async function createBackgroundAuthorizationResponseFixtureV1(
  seed = 24_500,
): Promise<BackgroundAuthorizationResponseFixtureV1> {
  const credentialState = await createProcessorCredentialFixtureV1(seed);
  const response = createBackgroundAuthorizationResponseV1(
    credentialState.crypto,
    {
      credentialBytes: credentialState.created.bytes,
      issuingDeviceSigningPublicKey: credentialState.issuer.publicKey,
      issuingDeviceSigningPrivateKey: credentialState.issuer.privateKey,
    },
  );
  return { ...credentialState, response };
}
