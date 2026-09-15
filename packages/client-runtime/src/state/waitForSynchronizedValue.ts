// @effect-diagnostics globalTimers:off -- Promise bridge for UI atom subscriptions across clients.

export async function waitForSynchronizedValue<A>(input: {
  readonly read: () => A;
  readonly subscribe: (listener: (value: A) => void) => () => void;
  readonly isReady: (value: A) => boolean;
  readonly isUnavailable?: (value: A) => boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<boolean> {
  if (input.signal?.aborted === true) return false;
  const initialValue = input.read();
  if (input.isReady(initialValue)) return true;
  if (input.isUnavailable?.(initialValue) === true) return false;

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let timeout: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      if (timeout !== null) globalThis.clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
      unsubscribe?.();
      resolve(ready);
    };
    const abort = () => finish(false);

    const subscribedUnsubscribe = input.subscribe((value) => {
      if (input.isReady(value)) {
        finish(true);
      } else if (input.isUnavailable?.(value) === true) {
        finish(false);
      }
    });
    unsubscribe = subscribedUnsubscribe;
    if (settled) {
      subscribedUnsubscribe();
      return;
    }
    const subscribedValue = input.read();
    if (input.isReady(subscribedValue)) {
      finish(true);
      return;
    }
    if (input.isUnavailable?.(subscribedValue) === true) {
      finish(false);
      return;
    }
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted === true) {
      finish(false);
      return;
    }
    if (input.timeoutMs !== undefined) {
      timeout = globalThis.setTimeout(() => finish(false), input.timeoutMs);
    }
  });
}
