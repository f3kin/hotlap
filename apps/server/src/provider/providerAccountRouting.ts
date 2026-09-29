export interface ProviderAccountRoutingOptionSelection {
  readonly id: string;
  readonly value: string | boolean;
}

export interface ProviderAccountRoutingOptionDescriptor {
  readonly id: string;
  readonly type: "select" | "boolean";
  readonly options?: ReadonlyArray<{ readonly id: string }> | undefined;
}

export interface ProviderAccountRoutingModel {
  readonly slug: string;
  readonly capabilities: {
    readonly optionDescriptors?: ReadonlyArray<ProviderAccountRoutingOptionDescriptor> | undefined;
  } | null;
}

export interface ProviderAccountRoutingUsageWindow {
  readonly id: string;
  readonly kind: "session" | "weekly" | "monthly" | "other";
  readonly usedPercent: number;
  readonly resetsAt?: string | undefined;
}

export interface ProviderAccountRoutingProvider {
  readonly instanceId: string;
  readonly driver: string;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly status: string;
  readonly auth: { readonly status: string; readonly email?: string | undefined };
  readonly availability?: string | undefined;
  readonly continuation?: { readonly groupKey: string } | undefined;
  readonly models: ReadonlyArray<ProviderAccountRoutingModel>;
  readonly usageLimits?:
    | {
        readonly checkedAt: string;
        readonly windows: ReadonlyArray<ProviderAccountRoutingUsageWindow>;
        readonly unavailable?: { readonly reason: string } | undefined;
      }
    | undefined;
}

export interface ProviderAccountRoutingInput {
  readonly routingMode: "auto" | "fixed";
  readonly instanceIds: ReadonlyArray<string>;
  readonly usageThresholdPercent: number | null;
  readonly threadHasStarted: boolean;
  readonly modelSelection: {
    readonly instanceId: string;
    readonly model: string;
    readonly options?: ReadonlyArray<ProviderAccountRoutingOptionSelection> | undefined;
  };
  readonly providers: ReadonlyArray<ProviderAccountRoutingProvider>;
  readonly nowMs: number;
  readonly maxUsageAgeMs: number;
  /** Accounts that just rejected this message with a usage limit, whatever their stored usage says. */
  readonly limitedInstanceIds?: ReadonlyArray<string> | undefined;
}

export interface ProviderAccountRoutingDecision {
  readonly targetInstanceIds: ReadonlyArray<string>;
  readonly reason: "initial-placement" | "usage-threshold" | "current-unusable";
}

function relevantWindows(
  provider: ProviderAccountRoutingProvider,
): ReadonlyArray<ProviderAccountRoutingUsageWindow> {
  if (provider.driver === "codex") {
    return provider.usageLimits?.windows.filter((window) => window.kind === "weekly") ?? [];
  }
  if (provider.driver === "claudeAgent") {
    const windows =
      provider.usageLimits?.windows.filter(
        (window) =>
          (window.id === "five_hour" && window.kind === "session") ||
          (window.id === "seven_day" && window.kind === "weekly"),
      ) ?? [];
    return windows.some((window) => window.id === "five_hour") &&
      windows.some((window) => window.id === "seven_day")
      ? windows
      : [];
  }
  return [];
}

function freshRelevantWindows(
  provider: ProviderAccountRoutingProvider,
  input: Pick<ProviderAccountRoutingInput, "nowMs" | "maxUsageAgeMs">,
): ReadonlyArray<ProviderAccountRoutingUsageWindow> | null {
  const usage = provider.usageLimits;
  if (!usage || usage.unavailable || input.maxUsageAgeMs < 0) return null;
  const checkedAtMs = Date.parse(usage.checkedAt);
  if (
    !Number.isFinite(checkedAtMs) ||
    checkedAtMs > input.nowMs ||
    input.nowMs - checkedAtMs > input.maxUsageAgeMs
  ) {
    return null;
  }
  const windows = relevantWindows(provider);
  if (windows.length === 0) return null;
  return windows.every((window) => {
    const resetsAtMs = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    return (
      Number.isFinite(window.usedPercent) &&
      window.usedPercent >= 0 &&
      window.usedPercent <= 100 &&
      Number.isFinite(resetsAtMs) &&
      resetsAtMs > input.nowMs
    );
  })
    ? windows
    : null;
}

/** Returns true only from explicit provider state or a fresh exhausted account-wide limit. */
export function isProviderAccountConfirmedUnusable(
  provider: ProviderAccountRoutingProvider,
  input: Pick<ProviderAccountRoutingInput, "nowMs" | "maxUsageAgeMs">,
): boolean {
  if (
    !provider.enabled ||
    !provider.installed ||
    provider.status !== "ready" ||
    provider.auth.status === "unauthenticated" ||
    provider.availability === "unavailable"
  ) {
    return true;
  }
  return (
    freshRelevantWindows(provider, input)?.some((window) => window.usedPercent >= 100) === true
  );
}

function hasCompatibleModel(
  provider: ProviderAccountRoutingProvider,
  modelSelection: ProviderAccountRoutingInput["modelSelection"],
): boolean {
  const model = provider.models.find((candidate) => candidate.slug === modelSelection.model);
  if (!model) return false;
  return (modelSelection.options ?? []).every((selection) => {
    const descriptor = model.capabilities?.optionDescriptors?.find(
      (candidate) => candidate.id === selection.id,
    );
    if (!descriptor) return false;
    if (descriptor.type === "boolean") return typeof selection.value === "boolean";
    return (
      typeof selection.value === "string" &&
      descriptor.options?.some((option) => option.id === selection.value) === true
    );
  });
}

function isValidThreshold(value: number | null): value is number {
  return value !== null && Number.isInteger(value) && value >= 1 && value <= 100;
}

interface EligibleCandidate {
  readonly instanceId: string;
  readonly weeklyResetMs: number;
  readonly maxRelevantUsage: number;
}

function compareCandidates(a: EligibleCandidate, b: EligibleCandidate): number {
  if (a.weeklyResetMs !== b.weeklyResetMs) return a.weeklyResetMs - b.weeklyResetMs;
  if (a.maxRelevantUsage !== b.maxRelevantUsage) {
    return a.maxRelevantUsage - b.maxRelevantUsage;
  }
  return a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0;
}

export function selectAutomaticProviderAccount(
  input: ProviderAccountRoutingInput,
): ProviderAccountRoutingDecision | null {
  const threshold = input.usageThresholdPercent;
  if (input.routingMode !== "auto" || !isValidThreshold(threshold)) return null;
  const instanceIds = [...new Set(input.instanceIds)];
  if (instanceIds.length < 2 || !instanceIds.includes(input.modelSelection.instanceId)) return null;

  const current = input.providers.find(
    (provider) => provider.instanceId === input.modelSelection.instanceId,
  );
  if (!current || (current.driver !== "codex" && current.driver !== "claudeAgent")) return null;
  const limited = new Set(input.limitedInstanceIds ?? []);
  // Once the current account has rejected the message, any account not known to be
  // exhausted beats failing it: the threshold and stale readings stop mattering.
  const currentRejected = limited.has(current.instanceId);

  const candidates = instanceIds.flatMap((instanceId): ReadonlyArray<EligibleCandidate> => {
    const candidate = input.providers.find((provider) => provider.instanceId === instanceId);
    const candidateWindows = candidate ? freshRelevantWindows(candidate, input) : null;
    // Claude copies the transcript into the target account, so only Codex needs a shared home.
    const hasCompatibleContinuation =
      !input.threadHasStarted ||
      current.driver !== "codex" ||
      (current.continuation?.groupKey !== undefined &&
        candidate?.continuation?.groupKey === current.continuation.groupKey);
    const hasRoom = currentRejected
      ? !candidateWindows?.some((window) => window.usedPercent >= 100)
      : candidateWindows?.every((window) => window.usedPercent < threshold) === true;
    if (
      candidate &&
      !limited.has(candidate.instanceId) &&
      candidate.driver === current.driver &&
      candidate.enabled &&
      candidate.installed &&
      candidate.status === "ready" &&
      candidate.auth.status === "authenticated" &&
      candidate.availability !== "unavailable" &&
      hasCompatibleContinuation &&
      hasCompatibleModel(candidate, input.modelSelection) &&
      hasRoom
    ) {
      // An account without a fresh reading is tried last.
      if (candidateWindows === null) {
        return [
          { instanceId: candidate.instanceId, weeklyResetMs: Infinity, maxRelevantUsage: 100 },
        ];
      }
      const weeklyResetMs = Math.min(
        ...candidateWindows
          .filter((window) => window.kind === "weekly")
          .map((window) => Date.parse(window.resetsAt ?? "")),
      );
      return [
        {
          instanceId: candidate.instanceId,
          weeklyResetMs,
          maxRelevantUsage: Math.max(...candidateWindows.map((window) => window.usedPercent)),
        },
      ];
    }
    return [];
  });

  const currentUnusable = currentRejected || isProviderAccountConfirmedUnusable(current, input);
  // Moving a started Claude thread costs a cold prompt cache, so it moves only when blocked.
  if (input.threadHasStarted && !currentUnusable && current.driver === "claudeAgent") return null;
  if (input.threadHasStarted && !currentUnusable) {
    const currentWindows = freshRelevantWindows(current, input);
    if (!currentWindows?.some((window) => window.usedPercent >= threshold)) {
      return null;
    }
  }

  const targets = candidates
    .filter((candidate) => candidate.instanceId !== current.instanceId)
    .sort(compareCandidates);
  const target = targets[0];
  if (!target) return null;

  if (!input.threadHasStarted) {
    const currentCandidate = candidates.find(
      (candidate) => candidate.instanceId === current.instanceId,
    );
    if (currentCandidate && compareCandidates(currentCandidate, target) <= 0) return null;
  }

  return {
    targetInstanceIds: targets.map((candidate) => candidate.instanceId),
    reason: !input.threadHasStarted
      ? "initial-placement"
      : currentUnusable
        ? "current-unusable"
        : "usage-threshold",
  };
}

/**
 * True when every pool account rejected the message or has a fresh reading at its limit.
 * An account removed from the providers can never take the message, so it counts as limited.
 */
export function isEveryProviderAccountLimited(
  input: Pick<
    ProviderAccountRoutingInput,
    "instanceIds" | "providers" | "limitedInstanceIds" | "nowMs" | "maxUsageAgeMs"
  >,
): boolean {
  const limited = new Set(input.limitedInstanceIds ?? []);
  return input.instanceIds.every((instanceId) => {
    if (limited.has(instanceId)) return true;
    const provider = input.providers.find((candidate) => candidate.instanceId === instanceId);
    return (
      provider === undefined ||
      freshRelevantWindows(provider, input)?.some((window) => window.usedPercent >= 100) === true
    );
  });
}

/**
 * When the first exhausted pool account becomes usable again: each account waits
 * for every exhausted window it has. Stale usage still counts here, because a
 * reset time in the future stays true after the reading ages.
 */
export function soonestProviderAccountResetMs(input: {
  readonly instanceIds: ReadonlyArray<string>;
  readonly providers: ReadonlyArray<ProviderAccountRoutingProvider>;
  readonly nowMs: number;
}): number | null {
  let soonest: number | null = null;
  for (const instanceId of new Set(input.instanceIds)) {
    const provider = input.providers.find((candidate) => candidate.instanceId === instanceId);
    const resets = (provider ? relevantWindows(provider) : [])
      .filter((window) => window.usedPercent >= 100)
      .map((window) => Date.parse(window.resetsAt ?? ""))
      .filter((resetsAtMs) => Number.isFinite(resetsAtMs) && resetsAtMs > input.nowMs);
    if (resets.length === 0) continue;
    const usableAtMs = Math.max(...resets);
    soonest = soonest === null ? usableAtMs : Math.min(soonest, usableAtMs);
  }
  return soonest;
}
