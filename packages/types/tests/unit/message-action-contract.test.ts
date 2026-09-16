import { describe, expect, test } from "bun:test";

import {
  getMessageActionDescriptors,
  type MessageActionCapabilities,
  type MessageActionId,
  type MessageActionSurface,
} from "../../src/message-action-contract";

const CAPABILITY_KEYS = ["reply", "react", "replyInThread", "copy", "report", "edit", "delete"] as const;

const EXPECTED_ORDER: Readonly<Record<MessageActionSurface, readonly MessageActionId[]>> = {
  room: ["reply", "react", "reply-in-thread", "copy", "edit", "report", "delete"],
  subthread: ["reply", "react", "copy", "edit", "report", "delete"],
};

const EXPECTED_LABELS: Readonly<Record<MessageActionId, string>> = {
  reply: "Reply",
  react: "React",
  "reply-in-thread": "Reply in thread",
  copy: "Copy message",
  report: "Report message",
  edit: "Edit message",
  delete: "Delete message",
};

function capabilitiesFor(mask: number): MessageActionCapabilities {
  return {
    reply: Boolean(mask & (1 << 0)),
    react: Boolean(mask & (1 << 1)),
    replyInThread: Boolean(mask & (1 << 2)),
    copy: Boolean(mask & (1 << 3)),
    report: Boolean(mask & (1 << 4)),
    edit: Boolean(mask & (1 << 5)),
    delete: Boolean(mask & (1 << 6)),
  };
}

function capabilityForAction(
  id: MessageActionId,
  capabilities: MessageActionCapabilities,
): boolean {
  switch (id) {
    case "reply":
      return capabilities.reply;
    case "react":
      return capabilities.react;
    case "reply-in-thread":
      return capabilities.replyInThread;
    case "copy":
      return capabilities.copy;
    case "report":
      return capabilities.report === true;
    case "edit":
      return capabilities.edit;
    case "delete":
      return capabilities.delete;
  }
}

describe("getMessageActionDescriptors", () => {
  test.each(["room", "subthread"] as const)(
    "returns the locked %s order across every capability permutation",
    (surface) => {
      for (let mask = 0; mask < 1 << CAPABILITY_KEYS.length; mask += 1) {
        const capabilities = capabilitiesFor(mask);
        const descriptors = getMessageActionDescriptors({ surface, capabilities });
        const expectedIds = EXPECTED_ORDER[surface].filter((id) =>
          capabilityForAction(id, capabilities),
        );

        expect(descriptors.map((descriptor) => descriptor.id)).toEqual(expectedIds);
        expect(descriptors.map((descriptor) => descriptor.accessibleLabel)).toEqual(
          expectedIds.map((id) => EXPECTED_LABELS[id]),
        );
        expect(descriptors.map((descriptor) => descriptor.destructive)).toEqual(
          expectedIds.map((id) => id === "delete"),
        );
      }
    },
  );

  test("subthread structurally suppresses Reply in thread even when eligible", () => {
    const descriptors = getMessageActionDescriptors({
      surface: "subthread",
      capabilities: {
        reply: false,
        react: false,
        replyInThread: true,
        copy: false,
        report: false,
        edit: false,
        delete: false,
      },
    });

    expect(descriptors).toEqual([]);
  });

  test("omits every action when every capability is false", () => {
    expect(
      getMessageActionDescriptors({
        surface: "room",
        capabilities: {
          reply: false,
          react: false,
          replyInThread: false,
          copy: false,
          report: false,
          edit: false,
          delete: false,
        },
      }),
    ).toEqual([]);
  });

  test("places eligible Edit immediately before Delete", () => {
    const descriptors = getMessageActionDescriptors({
      surface: "room",
      capabilities: {
        reply: false,
        react: false,
        replyInThread: false,
        copy: false,
        report: false,
        edit: true,
        delete: true,
      },
    });

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual(["edit", "delete"]);
  });
});
