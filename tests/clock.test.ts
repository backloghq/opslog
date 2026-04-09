import { describe, it, expect } from "vitest";
import { LamportClock } from "../src/clock.js";

describe("LamportClock", () => {
  it("starts at 0 by default", () => {
    const clock = new LamportClock();
    expect(clock.current).toBe(0);
  });

  it("starts at a given initial value", () => {
    const clock = new LamportClock(42);
    expect(clock.current).toBe(42);
  });

  it("tick() increments and returns the new value", () => {
    const clock = new LamportClock();
    expect(clock.tick()).toBe(1);
    expect(clock.tick()).toBe(2);
    expect(clock.tick()).toBe(3);
    expect(clock.current).toBe(3);
  });

  it("merge() advances past the received value", () => {
    const clock = new LamportClock(5);
    const result = clock.merge(10);
    expect(result).toBe(11);
    expect(clock.current).toBe(11);
  });

  it("merge() stays ahead when local is higher", () => {
    const clock = new LamportClock(20);
    const result = clock.merge(5);
    expect(result).toBe(21);
    expect(clock.current).toBe(21);
  });

  it("merge() handles equal values", () => {
    const clock = new LamportClock(10);
    const result = clock.merge(10);
    expect(result).toBe(11);
  });

  it("maintains causality across tick and merge", () => {
    const clockA = new LamportClock();
    const clockB = new LamportClock();

    const a1 = clockA.tick(); // 1
    const a2 = clockA.tick(); // 2
    const b1 = clockB.merge(a1); // max(0, 1) + 1 = 2
    const b2 = clockB.tick(); // 3
    const a3 = clockA.merge(b2); // max(2, 3) + 1 = 4

    expect(a1).toBe(1);
    expect(a2).toBe(2);
    expect(b1).toBe(2);
    expect(b2).toBe(3);
    expect(a3).toBe(4);
  });
});
