import { describe, expect, it, vi } from "@effect/vitest";

import { waitForSynchronizedValue } from "./waitForSynchronizedValue.ts";

describe("waitForSynchronizedValue", () => {
  it("resolves when a subscribed value becomes ready", async () => {
    let value: string | null = null;
    const observer: { listener: ((next: string | null) => void) | null } = { listener: null };
    const waiting = waitForSynchronizedValue({
      read: () => value,
      subscribe: (next) => {
        observer.listener = next;
        return () => {
          observer.listener = null;
        };
      },
      isReady: (next) => next !== null,
      timeoutMs: 100,
    });

    value = "ready";
    observer.listener?.(value);

    await expect(waiting).resolves.toBe(true);
    expect(observer.listener).toBeNull();
  });

  it("returns false and unsubscribes after the timeout", async () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    const waiting = waitForSynchronizedValue({
      read: () => null,
      subscribe: () => unsubscribe,
      isReady: () => false,
      timeoutMs: 100,
    });

    await vi.advanceTimersByTimeAsync(100);

    await expect(waiting).resolves.toBe(false);
    expect(unsubscribe).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("returns false and unsubscribes when cancelled", async () => {
    const controller = new AbortController();
    const unsubscribe = vi.fn();
    const waiting = waitForSynchronizedValue({
      read: () => null,
      subscribe: () => unsubscribe,
      isReady: () => false,
      timeoutMs: 10_000,
      signal: controller.signal,
    });

    controller.abort();

    await expect(waiting).resolves.toBe(false);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("returns false and unsubscribes when synchronization becomes unavailable", async () => {
    let value: "pending" | "failed" = "pending";
    const observer: { listener: ((next: "pending" | "failed") => void) | null } = {
      listener: null,
    };
    const waiting = waitForSynchronizedValue({
      read: () => value,
      subscribe: (next) => {
        observer.listener = next;
        return () => {
          observer.listener = null;
        };
      },
      isReady: () => false,
      isUnavailable: (next) => next === "failed",
    });

    value = "failed";
    observer.listener?.(value);

    await expect(waiting).resolves.toBe(false);
    expect(observer.listener).toBeNull();
  });

  it("can wait without turning a slow synchronization into a failure", async () => {
    vi.useFakeTimers();
    let value: string | null = null;
    const observer: { listener: ((next: string | null) => void) | null } = { listener: null };
    const waiting = waitForSynchronizedValue({
      read: () => value,
      subscribe: (next) => {
        observer.listener = next;
        return () => {
          observer.listener = null;
        };
      },
      isReady: (next) => next !== null,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    value = "ready";
    observer.listener?.(value);

    await expect(waiting).resolves.toBe(true);
    expect(observer.listener).toBeNull();
    vi.useRealTimers();
  });
});
