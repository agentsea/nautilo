import { describe, expect, test } from "bun:test";
import {
  AgentInvocationRequiredError,
  StrictShadowProtectedContentRequiredError,
} from "@nautilo/api-client/browser";
import { roomMessageSendFailureReason } from "../../src/lib/room-message-send-failure";

describe("roomMessageSendFailureReason", () => {
  const readableDenial =
    "You don’t have permission to ask Genie or other agents to respond.";

  test("translates the typed browser capability denial", () => {
    expect(roomMessageSendFailureReason(new AgentInvocationRequiredError())).toBe(
      readableDenial,
    );
  });

  test("translates the same stable denial after Electron IPC wrapping", () => {
    expect(
      roomMessageSendFailureReason(
        new Error(
          "Error invoking remote method 'ordinaryChat:sendRoomMessage': Error: invoke_agents_required",
        ),
      ),
    ).toBe(readableDenial);
  });

  test("translates Electron's cross-realm error-shaped rejection", () => {
    const ipcError = Object.assign(Object.create(null) as object, {
      message:
        "Error invoking remote method 'ordinaryChat:sendRoomMessage': AgentInvocationRequiredError: invoke_agents_required",
    });

    expect(roomMessageSendFailureReason(ipcError)).toBe(readableDenial);
  });

  test("translates Electron IPC-wrapped normalization rejections without reflecting paths or content", () => {
    const result = roomMessageSendFailureReason(
      new Error(
        "Error invoking remote method 'ordinaryChat:sendRoomMessage': Error: remote ordinary body normalization rejected function at $.activeMiniApp.selection.secretKey — selected text: do not show this",
      ),
    );

    expect(result).toBe(
      "This message includes unsupported app/context data (function). Change or close the active selection or context, then try again.",
    );
    expect(result).not.toContain("secretKey");
    expect(result).not.toContain("do not show this");
    expect(result).not.toContain("ordinaryChat:sendRoomMessage");
  });

  test("preserves only allowlisted normalization value classes", () => {
    const expectedPrefix = "This message includes unsupported app/context data (";
    const expectedSuffix = "). Change or close the active selection or context, then try again.";

    for (const valueClass of [
      "function",
      "symbol",
      "bigint",
      "non-finite number",
      "cyclic reference",
      "unsupported object",
      "nesting limit",
      "undefined",
    ]) {
      expect(
        roomMessageSendFailureReason(
          new Error(
            `Error invoking remote method 'ordinaryChat:sendRoomMessage': Error: remote ordinary body normalization rejected ${valueClass} at $.untrusted.path`,
          ),
        ),
      ).toBe(`${expectedPrefix}${valueClass}${expectedSuffix}`);
    }
  });

  test("does not treat malformed normalization-like failures as safe rejections", () => {
    const malformed =
      "remote ordinary body normalization rejected functionally at $.untrusted.path";

    expect(roomMessageSendFailureReason(new Error(malformed))).toBe(malformed);
  });

  test("preserves unrelated failures", () => {
    expect(roomMessageSendFailureReason(new Error("Network unavailable"))).toBe(
      "Network unavailable",
    );
  });

  test("explains Strict authority waits and terminal device failures without coordinates", () => {
    expect(roomMessageSendFailureReason(
      new StrictShadowProtectedContentRequiredError(
        425,
        "waiting_for_authority",
        "namespace_authority_converging",
        true,
      ),
    )).toContain("room is still syncing");
    expect(roomMessageSendFailureReason(new Error(
      "Error invoking remote method 'ordinaryChat:sendRoomMessage': Error: strict_shadow_protected_content_required:failed:device_removed:terminal",
    ))).toContain("Settings → Encryption");
  });

  test("shared protected denials do not mislabel Full as Strict Shadow", () => {
    for (const reason of ["integrity_failure", "unsupported_operation"] as const) {
      const browser = roomMessageSendFailureReason(
        new StrictShadowProtectedContentRequiredError(409, "failed", reason, false),
      );
      const desktop = roomMessageSendFailureReason(new Error(
        `strict_shadow_protected_content_required:failed:${reason}:terminal`,
      ));
      expect(browser).toBe(desktop);
      expect(browser).toContain("Admin → Encryption");
      expect(browser).not.toContain("Strict Shadow");
      expect(browser).not.toContain("Fallback Shadow");
    }
  });
});
