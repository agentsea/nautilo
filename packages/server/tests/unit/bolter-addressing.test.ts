import { expect, test } from "bun:test";
import { isBolterMessageAddressed } from "../../src/messaging/bolter-addressing";

const self = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const mention = (id: string, label = "Assistant") => `[@${label}](#mention-aid:${id})`;
const human = { senderType: "user" as const, addressed: false, content: "Please help with the sample page." };

test("canonical mentions select only their recipients, including multiple recipients", () => {
  for (const addressed of [false, true]) {
    expect(isBolterMessageAddressed({ ...human, addressed, content: `${mention(other)} Please help.` }, self)).toBe(false);
    expect(isBolterMessageAddressed({ ...human, addressed, content: `${mention(self)} Please help.` }, self)).toBe(true);
    expect(isBolterMessageAddressed({ ...human, addressed, content: `${mention(other)} ${mention(self)}` }, self)).toBe(true);
  }
});

test("full picker IDs match qualified CLI aliases without matching a different full ID", () => {
  expect(isBolterMessageAddressed({ ...human, content: mention(self) }, "11111111")).toBe(true);
  expect(isBolterMessageAddressed({ ...human, content: mention("11111111") }, self)).toBe(true);
  expect(isBolterMessageAddressed({ ...human, content: mention(self.toUpperCase()) }, self)).toBe(true);
  expect(isBolterMessageAddressed({ ...human, content: mention("11111111-9999-4999-8999-999999999999") }, self)).toBe(false);
});

test("display names and ordinary prose do not select agent identities", () => {
  expect(isBolterMessageAddressed({ ...human, content: mention(other, "Assistant") }, self)).toBe(false);
  expect(isBolterMessageAddressed({ ...human, content: mention(self, "Renamed helper") }, self)).toBe(true);
  expect(isBolterMessageAddressed(human, self)).toBe(true);
  expect(isBolterMessageAddressed({ ...human, content: "Builder suggested a clearer heading. Can you help?" }, self)).toBe(true);
});

test("agent messages retain the provider addressivity requirement", () => {
  for (const content of [human.content, mention(self), `${mention(other)} ${mention(self)}`]) {
    expect(isBolterMessageAddressed({ senderType: "anima", addressed: false, content }, self)).toBe(false);
    expect(isBolterMessageAddressed({ senderType: "anima", addressed: true, content }, self)).toBe(true);
  }
  expect(isBolterMessageAddressed({ senderType: "anima", addressed: true, content: mention(other) }, self)).toBe(false);
  expect(isBolterMessageAddressed({ senderType: "system", addressed: true, content: mention(self) }, self)).toBe(false);
});
