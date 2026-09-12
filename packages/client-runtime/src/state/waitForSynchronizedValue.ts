// @effect-diagnostics globalTimers:off -- Promise bridge for UI atom subscriptions across clients.

export async function waitForSynchronizedValue<A>(input: {
  readonly read: () => A;
  readonly subscribe: (listener: (value: A) => void) => () => void;
  readonly isReady: (value: A) => boolean;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<boolean> {
  if (input.signal?.aborted === true) return false;
  if (input.isReady(input.read())) return true;

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
      if (input.isReady(value)) finish(true);
    });
    unsubscribe = subscribedUnsubscribe;
    if (settled) {
      subscribedUnsubscribe();
      return;
    }
    if (input.isReady(input.read())) {
      finish(true);
      return;
    }
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted === true) {
      finish(false);
      return;
    }
    timeout = globalThis.setTimeout(() => finish(false), input.timeoutMs);
  });
}
