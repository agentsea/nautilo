import { describe, expect, test } from "bun:test";
import { DEFAULT_FRAME_RATE } from "../edl";
import {
  frameRateToFramesPerSecond,
  frameToSeconds,
  normalizeFrameRate,
  secondsToFrame,
  sequenceFrameRate,
} from "./timing";

describe("timeline frame timing", () => {
  test("uses the visible 30/1 default without sharing mutable state", () => {
    const rate = normalizeFrameRate(undefined);
    expect(rate).toEqual(DEFAULT_FRAME_RATE);
    expect(rate).not.toBe(DEFAULT_FRAME_RATE);
    rate.numerator = 60;
    expect(DEFAULT_FRAME_RATE).toEqual({ numerator: 30, denominator: 1 });
  });

  test("converts seconds and frames through rational rates", () => {
    const ntsc = { numerator: 24_000, denominator: 1_001 };
    expect(frameRateToFramesPerSecond(ntsc)).toBeCloseTo(23.976023976);
    expect(secondsToFrame(10, ntsc)).toBe(240);
    expect(frameToSeconds(240, ntsc)).toBeCloseTo(10.01);
    expect(frameToSeconds(secondsToFrame(10, ntsc), ntsc)).toBeCloseTo(10.01);
  });

  test("offers explicit frame rounding and preserves seconds at rest", () => {
    const rate = { numerator: 30, denominator: 1 };
    expect(secondsToFrame(1.016, rate, "floor")).toBe(30);
    expect(secondsToFrame(1.016, rate, "nearest")).toBe(30);
    expect(secondsToFrame(1.016, rate, "ceil")).toBe(31);
    expect(frameToSeconds(30.5, rate)).toBeCloseTo(1.0166666667);
  });

  test("rejects invalid frame-rate and non-finite conversion inputs", () => {
    expect(() => normalizeFrameRate({ numerator: 0, denominator: 1 })).toThrow("positive integer");
    expect(() => secondsToFrame(Number.NaN, { numerator: 30, denominator: 1 })).toThrow("finite");
  });

  test("reads an omitted legacy sequence rate as 30/1", () => {
    expect(sequenceFrameRate({})).toEqual({ numerator: 30, denominator: 1 });
  });
});
