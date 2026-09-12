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
});
