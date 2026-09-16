import { describe, expect, test } from "bun:test";
import {
  RECENT_CONVERSATION_LIMIT_DEFAULT,
  MAX_ROOM_CONTEXT_PERCENT_DEFAULT,
  MINIMUM_FULL_TURNS_DEFAULT,
  PASSIVE_RECALL_ENABLED_DEFAULT,
  REFLECTION_SLEEP_ENABLED_DEFAULT,
  STENOGRAPHER_PRIOR_CONVERSATION_LIMIT_DEFAULT,
  isMaxRoomContextPercent,
  isMinimumFullTurns,
  isRecentConversationLimit,
  isStenographerPriorConversationLimit,
  resolveServerContextConfig,
} from "../../src";

describe("server context config", () => {
  test("defaults a missing row to the default-on Reflection policy", () => {
    expect(REFLECTION_SLEEP_ENABLED_DEFAULT).toBe(true);
    expect(resolveServerContextConfig(null)).toEqual({
      recentConversationLimit: RECENT_CONVERSATION_LIMIT_DEFAULT,
      minimumFullTurns: MINIMUM_FULL_TURNS_DEFAULT,
      maxRoomContextPercent: MAX_ROOM_CONTEXT_PERCENT_DEFAULT,
      stenographerPriorConversationLimit:
        STENOGRAPHER_PRIOR_CONVERSATION_LIMIT_DEFAULT,
      passiveRecallEnabled: PASSIVE_RECALL_ENABLED_DEFAULT,
      reflectionSleepEnabled: REFLECTION_SLEEP_ENABLED_DEFAULT,
      memoryReviewEnabled: null,
    });
  });

  test("preserves an existing explicit Reflection off selection", () => {
    expect(resolveServerContextConfig({
      recentConversationLimit: 50,
      minimumFullTurns: 1,
      maxRoomContextPercent: 50,
      stenographerPriorConversationLimit: 10,
      passiveRecallEnabled: true,
      reflectionSleepEnabled: false,
      memoryReviewEnabled: null,
    }).reflectionSleepEnabled).toBe(false);
  });

  test.each([10, 50, 100])("accepts configured limit %i", (recentConversationLimit) => {
    expect(resolveServerContextConfig({
      recentConversationLimit,
      minimumFullTurns: 1,
      maxRoomContextPercent: 50,
      stenographerPriorConversationLimit: 10,
      passiveRecallEnabled: false,
      reflectionSleepEnabled: true,
      memoryReviewEnabled: null,
    })).toEqual({
      recentConversationLimit,
      minimumFullTurns: 1,
      maxRoomContextPercent: 50,
      stenographerPriorConversationLimit: 10,
      passiveRecallEnabled: false,
      reflectionSleepEnabled: true,
      memoryReviewEnabled: null,
    });
    expect(isRecentConversationLimit(recentConversationLimit)).toBe(true);
  });

  test.each([9, 10.5, 101])("rejects invalid limit %p", (value) => {
    expect(isRecentConversationLimit(value)).toBe(false);
  });

  test.each([0, 1, 10])("accepts minimum full turns %i", (value) => {
    expect(isMinimumFullTurns(value)).toBe(true);
  });

  test.each([-1, 1.5, 11])("rejects invalid minimum full turns %p", (value) => {
    expect(isMinimumFullTurns(value)).toBe(false);
  });

  test.each([30, 50, 80])("accepts Room context percent %i", (value) => {
    expect(isMaxRoomContextPercent(value)).toBe(true);
  });

  test.each([29, 50.5, 81])("rejects invalid Room context percent %p", (value) => {
    expect(isMaxRoomContextPercent(value)).toBe(false);
  });

  test.each([0, 10, 50])("accepts Stenographer prior-context limit %i", (value) => {
    expect(isStenographerPriorConversationLimit(value)).toBe(true);
  });

  test.each([-1, 10.5, 51])("rejects invalid Stenographer prior-context limit %p", (value) => {
    expect(isStenographerPriorConversationLimit(value)).toBe(false);
  });
});
