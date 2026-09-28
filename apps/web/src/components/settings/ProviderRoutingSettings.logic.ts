import type { ProviderRoutingAutoBlocker } from "@t3tools/client-runtime/provider-account-routing";
import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderRoutingMode,
  ServerProvider,
  ServerSettings,
} from "@t3tools/contracts";

import { resolveDefaultProviderModelSelection } from "../../providerInstances";
import type { ProviderRoutingPolicyPatch } from "./scopedSettings";

const ROUTABLE_DRIVERS = new Set(["codex", "claudeAgent"]);

export interface ProviderRoutingOption {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly displayName: string;
  /** Signed-in account email, when the provider reports one. */
  readonly email?: string;
}

export interface ProviderRoutingDisplayOption extends ProviderRoutingOption {
  readonly unavailable?: true;
}

function isRunnable(provider: ServerProvider): boolean {
  return (
    ROUTABLE_DRIVERS.has(provider.driver) &&
    provider.enabled &&
    provider.installed &&
    provider.status === "ready" &&
    provider.auth.status === "authenticated" &&
    provider.availability !== "unavailable"
  );
}

/** Provider instances a shared project can safely name on every selected environment. */
export function deriveProviderRoutingOptions(
  providersByEnvironment: ReadonlyArray<ReadonlyArray<ServerProvider>>,
): ReadonlyArray<ProviderRoutingOption> {
  const [representative, ...others] = providersByEnvironment;
  if (!representative) return [];

  return representative.flatMap((provider) => {
    if (!isRunnable(provider)) return [];
    const availableEverywhere = others.every((providers) =>
      providers.some(
        (candidate) =>
          candidate.instanceId === provider.instanceId &&
          candidate.driver === provider.driver &&
          isRunnable(candidate),
      ),
    );
    if (!availableEverywhere) return [];
    const email = provider.auth.email?.trim();
    return [
      {
        instanceId: provider.instanceId,
        driver: provider.driver,
        displayName: provider.displayName ?? provider.instanceId,
        ...(email ? { email } : {}),
      },
    ];
  });
}

export function toggleProviderRoutingInstance(
  instanceIds: ReadonlyArray<ProviderInstanceId>,
  instanceId: ProviderInstanceId,
  enabled: boolean,
): ReadonlyArray<ProviderInstanceId> {
  const uniqueIds = [...new Set(instanceIds)];
  if (enabled) {
    return uniqueIds.includes(instanceId) ? uniqueIds : [...uniqueIds, instanceId];
  }
  return uniqueIds.filter((candidate) => candidate !== instanceId);
}

/** Available accounts keep registry order; unavailable saved ids stay removable. */
export function mergeProviderRoutingOptions(
  driver: ProviderDriverKind,
  options: ReadonlyArray<ProviderRoutingOption>,
  selectedIds: ReadonlyArray<ProviderInstanceId>,
): ReadonlyArray<ProviderRoutingDisplayOption> {
  const optionsById = new Map(options.map((option) => [option.instanceId, option]));
  const unavailable = [...new Set(selectedIds)].flatMap(
    (instanceId): ReadonlyArray<ProviderRoutingDisplayOption> =>
      optionsById.has(instanceId)
        ? []
        : [
            {
              instanceId,
              driver,
              displayName: instanceId,
              unavailable: true,
            },
          ],
  );
  return [...options, ...unavailable];
}

/** The first thing standing between the current account and Auto, or null. */
export function providerRoutingAutoBlocker(
  options: ReadonlyArray<ProviderRoutingOption>,
  instanceIdsByDriver: Readonly<Record<string, ReadonlyArray<ProviderInstanceId>>>,
  usageThresholdPercent: number | null,
  selectedAccount: { readonly instanceId: ProviderInstanceId } | null | undefined,
): ProviderRoutingAutoBlocker | null {
  if (
    usageThresholdPercent === null ||
    !Number.isInteger(usageThresholdPercent) ||
    usageThresholdPercent < 1 ||
    usageThresholdPercent > 100
  ) {
    return "threshold";
  }
  const selectedOption = options.find(
    (option) => option.instanceId === selectedAccount?.instanceId,
  );
  if (!selectedOption) return "account-unavailable";
  const runnableIds = new Set(
    options
      .filter((option) => option.driver === selectedOption.driver)
      .map((option) => option.instanceId),
  );
  const selectedIds = instanceIdsByDriver[selectedOption.driver] ?? [];
  if (!selectedIds.includes(selectedOption.instanceId)) return "account-not-pooled";
  return new Set(selectedIds.filter((instanceId) => runnableIds.has(instanceId))).size >= 2
    ? null
    : "pool-too-small";
}

export function canEnableProviderRoutingAuto(
  options: ReadonlyArray<ProviderRoutingOption>,
  instanceIdsByDriver: Readonly<Record<string, ReadonlyArray<ProviderInstanceId>>>,
  usageThresholdPercent: number | null,
  selectedAccount: { readonly instanceId: ProviderInstanceId } | null | undefined,
): boolean {
  return (
    providerRoutingAutoBlocker(
      options,
      instanceIdsByDriver,
      usageThresholdPercent,
      selectedAccount,
    ) === null
  );
}

export function resolveProviderRoutingDefaultMode(
  currentMode: ProviderRoutingMode,
  options: ReadonlyArray<ProviderRoutingOption>,
  instanceIdsByDriver: Readonly<Record<string, ReadonlyArray<ProviderInstanceId>>>,
  usageThresholdPercent: number | null,
  selectedAccount: { readonly instanceId: ProviderInstanceId } | null | undefined,
): ProviderRoutingMode {
  return currentMode === "auto" &&
    !canEnableProviderRoutingAuto(
      options,
      instanceIdsByDriver,
      usageThresholdPercent,
      selectedAccount,
    )
    ? "fixed"
    : currentMode;
}

/** One settings target: its effective settings and its own environment's providers. */
interface ProviderRoutingTarget {
  readonly settings: Pick<ServerSettings, "providerRoutingPolicy" | "defaultModelSelection">;
  readonly providers: ReadonlyArray<ServerProvider>;
}

/**
 * Completes one target's routing-policy edit, judged only by that target's own
 * environment accounts and default account. Auto that would be invalid there
 * is saved as Fixed, so a multi-environment edit never enables an invalid
 * policy. Returns null when the policy does not change.
 */
export function resolveTargetProviderRoutingPolicyPatch(
  input: ProviderRoutingTarget & { readonly patch: ProviderRoutingPolicyPatch },
): ProviderRoutingPolicyPatch | null {
  const policy = input.settings.providerRoutingPolicy;
  const requestedMode = input.patch.defaultMode ?? policy.defaultMode;
  const nextMode = resolveProviderRoutingDefaultMode(
    requestedMode,
    deriveProviderRoutingOptions([input.providers]),
    { ...policy.instanceIdsByDriver, ...input.patch.instanceIdsByDriver },
    input.patch.usageThresholdPercent === undefined
      ? policy.usageThresholdPercent
      : input.patch.usageThresholdPercent,
    resolveDefaultProviderModelSelection(input.providers, input.settings.defaultModelSelection),
  );
  const patch =
    nextMode === requestedMode ? input.patch : { ...input.patch, defaultMode: nextMode };
  return Object.keys(patch).length === 0 ? null : patch;
}

/**
 * Number inputs report every keystroke, including the empty field between edits
 * (`null`) and in-progress values. Only a valid threshold is saved, so clearing
 * the field to retype it never disables Auto behind the user's back, and a
 * threshold edit never re-validates accounts: providers report `warning` right
 * after a restart, and nudging the threshold must not switch Auto off.
 */
export function providerRoutingThresholdPatch(
  usageThresholdPercent: number | null,
): ProviderRoutingPolicyPatch | null {
  const valid =
    usageThresholdPercent !== null &&
    Number.isInteger(usageThresholdPercent) &&
    usageThresholdPercent >= 1 &&
    usageThresholdPercent <= 100;
  return valid ? { usageThresholdPercent } : null;
}

/** What blocks Auto on the first target that cannot have it, each judged by its own environment. */
export function providerRoutingAutoBlockerForTargets(
  targets: ReadonlyArray<ProviderRoutingTarget>,
): ProviderRoutingAutoBlocker | null {
  if (targets.length === 0) return "account-unavailable";
  for (const target of targets) {
    const policy = target.settings.providerRoutingPolicy;
    const blocker = providerRoutingAutoBlocker(
      deriveProviderRoutingOptions([target.providers]),
      policy.instanceIdsByDriver,
      policy.usageThresholdPercent,
      resolveDefaultProviderModelSelection(target.providers, target.settings.defaultModelSelection),
    );
    if (blocker !== null) return blocker;
  }
  return null;
}

/**
 * Which Auto blocker the settings row explains. Only Auto uses the switch-at percentage,
 * so a project staying on Fixed is not asked to set one.
 */
export function providerRoutingSettingsStatusBlocker(
  mode: ProviderRoutingMode,
  blocker: ProviderRoutingAutoBlocker | null,
): ProviderRoutingAutoBlocker | null {
  return mode === "fixed" && blocker === "threshold" ? null : blocker;
}

export function supportsProviderAccountRouting(capabilities: object | null | undefined): boolean {
  return (
    capabilities !== null &&
    capabilities !== undefined &&
    "providerAccountRouting" in capabilities &&
    capabilities.providerAccountRouting === true
  );
}
