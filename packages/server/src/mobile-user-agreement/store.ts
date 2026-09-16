import {
  and,
  desc,
  eq,
  isNull,
  mobileUserAgreementAcceptances,
  type DirectDatabase,
  type MobileUserAgreementAcceptance,
} from "@nautilo/db";
import {
  MOBILE_USER_AGREEMENT_VERSIONS,
  type MobileUserAgreementAcceptanceDto,
  type MobileUserAgreementStateResponse,
} from "@nautilo/types";

function toDto(row: MobileUserAgreementAcceptance): MobileUserAgreementAcceptanceDto {
  return {
    agreementVersion: row.agreementVersion,
    policyVersion: row.policyVersion,
    recipientManifestVersion: row.recipientManifestVersion,
    acceptedAt: row.acceptedAt.toISOString(),
    withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
  };
}

function response(row: MobileUserAgreementAcceptance | undefined): MobileUserAgreementStateResponse {
  return {
    current: MOBILE_USER_AGREEMENT_VERSIONS,
    accepted: row !== undefined,
    acceptance: row ? toDto(row) : null,
  };
}

async function selectCurrent(
  db: Pick<DirectDatabase, "select">,
  userId: string,
): Promise<MobileUserAgreementAcceptance | undefined> {
  const [row] = await db
    .select()
    .from(mobileUserAgreementAcceptances)
    .where(and(
      eq(mobileUserAgreementAcceptances.userId, userId),
      eq(mobileUserAgreementAcceptances.agreementVersion, MOBILE_USER_AGREEMENT_VERSIONS.agreementVersion),
      eq(mobileUserAgreementAcceptances.policyVersion, MOBILE_USER_AGREEMENT_VERSIONS.policyVersion),
      eq(
        mobileUserAgreementAcceptances.recipientManifestVersion,
        MOBILE_USER_AGREEMENT_VERSIONS.recipientManifestVersion,
      ),
      isNull(mobileUserAgreementAcceptances.withdrawnAt),
    ))
    .orderBy(desc(mobileUserAgreementAcceptances.acceptedAt))
    .limit(1);
  return row;
}

export async function readMobileUserAgreementState(
  db: DirectDatabase,
  userId: string,
): Promise<MobileUserAgreementStateResponse> {
  return response(await selectCurrent(db, userId));
}

export async function acceptCurrentMobileUserAgreement(
  db: DirectDatabase,
  userId: string,
): Promise<MobileUserAgreementStateResponse> {
  return db.transaction(async (tx) => {
    const existing = await selectCurrent(tx, userId);
    if (existing) return response(existing);

    const acceptedAt = new Date();
    await tx
      .update(mobileUserAgreementAcceptances)
      .set({ withdrawnAt: acceptedAt })
      .where(and(
        eq(mobileUserAgreementAcceptances.userId, userId),
        isNull(mobileUserAgreementAcceptances.withdrawnAt),
      ));
    await tx
      .insert(mobileUserAgreementAcceptances)
      .values({
        userId,
        ...MOBILE_USER_AGREEMENT_VERSIONS,
        acceptedAt,
      })
      .onConflictDoNothing();

    const accepted = await selectCurrent(tx, userId);
    if (!accepted) throw new Error("Mobile user agreement acceptance did not commit");
    return response(accepted);
  });
}

export async function withdrawCurrentMobileUserAgreement(
  db: DirectDatabase,
  userId: string,
): Promise<MobileUserAgreementStateResponse> {
  await db
    .update(mobileUserAgreementAcceptances)
    .set({ withdrawnAt: new Date() })
    .where(and(
      eq(mobileUserAgreementAcceptances.userId, userId),
      isNull(mobileUserAgreementAcceptances.withdrawnAt),
    ));
  return response(undefined);
}
