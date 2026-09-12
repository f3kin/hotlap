// @effect-diagnostics globalTimers:off -- Promise bridge for UI atom subscriptions across clients.

export async function waitForSynchronizedValue<A>(input: {
  readonly read: () => A;
  readonly subscribe: (listener: (value: A) => void) => () => void;
  readonly isReady: (value: A) => boolean;
  readonly timeoutMs: number;
}): Promise<boolean> {
  if (input.isReady(input.read())) return true;

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let timeout: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      if (timeout !== null) globalThis.clearTimeout(timeout);
      unsubscribe?.();
      resolve(ready);
    };

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
    timeout = globalThis.setTimeout(() => finish(false), input.timeoutMs);
  });
}
