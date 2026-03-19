import { describe, it, expect, vi, beforeEach } from "vitest";
import { InFlightManager } from "../in-flight.js";

describe("InFlightManager", () => {
  let manager: InFlightManager;

  beforeEach(() => {
    manager = new InFlightManager(60_000);
  });

  it("tracks a message and returns a receipt handle", () => {
    const mockChannel = { ack: vi.fn(), nack: vi.fn() } as any;
    const handle = manager.track(mockChannel, 1);
    expect(handle).toBeTruthy();
    expect(typeof handle).toBe("string");
  });

  it("acks a tracked message", () => {
    const mockChannel = { ack: vi.fn(), nack: vi.fn() } as any;
    const handle = manager.track(mockChannel, 1);
    const result = manager.ack(handle);
    expect(result).toBe(true);
    expect(manager.ack(handle)).toBe(false);
  });

  it("nacks a tracked message", () => {
    const mockChannel = { ack: vi.fn(), nack: vi.fn() } as any;
    const handle = manager.track(mockChannel, 1);
    const result = manager.nack(handle);
    expect(result).toBe(true);
    expect(manager.nack(handle)).toBe(false);
  });

  it("returns false for unknown handle", () => {
    expect(manager.ack("nonexistent")).toBe(false);
    expect(manager.nack("nonexistent")).toBe(false);
  });
});
