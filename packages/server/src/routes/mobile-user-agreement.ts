import type { FastifyInstance } from "fastify";
import {
  MOBILE_USER_AGREEMENT_VERSION,
  isCurrentMobileUserAgreementVersion,
  type MobileUserAgreementStateResponse,
} from "@nautilo/types";

import { getServerDirectDb } from "../lib/server-direct-db";
import {
  acceptCurrentMobileUserAgreement,
  readMobileUserAgreementState,
  withdrawCurrentMobileUserAgreement,
} from "../mobile-user-agreement/store";

export interface MobileUserAgreementRoutesDeps {
  read?: (userId: string) => Promise<MobileUserAgreementStateResponse>;
  accept?: (userId: string) => Promise<MobileUserAgreementStateResponse>;
  withdraw?: (userId: string) => Promise<MobileUserAgreementStateResponse>;
}

export function mobileUserAgreementRoutes(
  app: FastifyInstance,
  deps: MobileUserAgreementRoutesDeps = {},
): void {
  const read = deps.read ?? ((userId: string) => readMobileUserAgreementState(getServerDirectDb(), userId));
  const accept = deps.accept ?? ((userId: string) => acceptCurrentMobileUserAgreement(getServerDirectDb(), userId));
  const withdraw = deps.withdraw ?? ((userId: string) => withdrawCurrentMobileUserAgreement(getServerDirectDb(), userId));

  app.get("/api/mobile-user-agreement", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });
    return reply.send(await read(userId));
  });

  app.put<{ Body: { agreementVersion?: unknown } }>(
    "/api/mobile-user-agreement",
    async (request, reply) => {
      const userId = request.sessionUserId;
      if (!userId) return reply.code(401).send({ error: "Unauthorized" });
      if (!isCurrentMobileUserAgreementVersion(request.body?.agreementVersion)) {
        return reply.code(409).send({
          error: "The Mobile agreement version is not supported by this Server",
          code: "mobile_user_agreement_version_mismatch",
          currentAgreementVersion: MOBILE_USER_AGREEMENT_VERSION,
        });
      }
      return reply.send(await accept(userId));
    },
  );

  app.delete("/api/mobile-user-agreement", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });
    return reply.send(await withdraw(userId));
  });
}
