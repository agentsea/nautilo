import { describe, expect, test } from "bun:test";

import { platformCapabilities as fallbackPlatform } from "@/platform/capabilities";
import { platformCapabilities as nativePlatform } from "@/platform/capabilities.native";
import { platformCapabilities as webPlatform } from "@/platform/capabilities.web";

import {
  dockedRoomChatCapabilitiesForPlatform,
  roomChatCapabilitiesForPlatform,
} from "./platform-capabilities";

describe("room chat platform capabilities", () => {
  test("keeps native media controls available", () => {
    expect(roomChatCapabilitiesForPlatform(nativePlatform)).toEqual({
      attachments: true,
      voiceInput: true,
      voicePlayback: true,
    });
  });

  test("fails closed for Web and unknown runtimes", () => {
    const unavailable = {
      attachments: false,
      voiceInput: false,
      voicePlayback: false,
    };
    expect(roomChatCapabilitiesForPlatform(webPlatform)).toEqual(unavailable);
    expect(roomChatCapabilitiesForPlatform(fallbackPlatform)).toEqual(unavailable);
  });

  test("keeps docked omissions while denying Web microphone input", () => {
    expect(dockedRoomChatCapabilitiesForPlatform(nativePlatform)).toEqual({
      attachments: false,
      voiceInput: true,
      voicePlayback: false,
    });
    expect(dockedRoomChatCapabilitiesForPlatform(webPlatform)).toEqual({
      attachments: false,
      voiceInput: false,
      voicePlayback: false,
    });
  });
});
