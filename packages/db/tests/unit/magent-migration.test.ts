import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { finalizeMagentTransportMigration, MAGENT_TRANSPORT_MARKER } from "../../scripts/finalize-magent-transport";

test("operator migration extends the qualified canonical final-reply guard and preserves lifecycle checks", () => {
  const schema = 'ALTER TABLE "bolter_connections" ADD COLUMN "transport_kind" text;';
  const result = finalizeMagentTransportMigration(schema);
  expect(finalizeMagentTransportMigration(result)).toBe(result);
  for (const required of [MAGENT_TRANSPORT_MARKER, "c.provider = NEW.provider", "c.user_id = NEW.user_id",
    "m.human_turn_id IS NULL", "j.status <> 'completed'", "i.state <> 'accepted'", "j.input IS DISTINCT FROM",
    "g.fingerprint = NEW.fingerprint", "AND NOT m.external_authorship", "'external_room_final_reply_v1'", "'bolter_final_reply_v1'",
    "GRANT TRIGGER ON TABLE public.bolter_room_bindings TO nautilo", "REVOKE TRIGGER ON TABLE public.bolter_room_bindings FROM nautilo"]) expect(result).toContain(required);
  const generated = readFileSync(new URL("../../src/migrations/0381_married_barracuda.sql", import.meta.url), "utf8");
  expect(generated).toContain(result.slice(result.indexOf(MAGENT_TRANSPORT_MARKER)));
  expect(generated).toContain('"operator_binding_id" IS NOT NULL');
  for (const field of ["relay_id", "desktop_session_id", "pairing_generation_ref", "home_handle"]) {
    expect(generated).toContain(`"${field}" IS NULL`);
    expect(generated).toContain(`"${field}" IS NOT NULL`);
  }
});
