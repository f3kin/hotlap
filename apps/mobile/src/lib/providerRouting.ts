import type {
  ModelSelection,
  ProviderInstanceId,
  ProviderRoutingMode,
  ServerProvider,
} from "@t3tools/contracts";

const ROUTABLE_DRIVERS = new Set(["codex", "claudeAgent"]);

function isRunnableRoutingProvider(provider: ServerProvider): boolean {
  return (
    ROUTABLE_DRIVERS.has(provider.driver) &&
    provider.enabled &&
    provider.installed &&
    provider.status === "ready" &&
    provider.auth.status === "authenticated" &&
    provider.availability !== "unavailable"
  );
}

export function canEnableProviderRoutingAuto(
  providers: ReadonlyArray<ServerProvider>,
  instanceIdsByDriver: Readonly<Record<string, ReadonlyArray<ProviderInstanceId>>>,
  usageThresholdPercent: number | null,
  selectedInstanceId: ProviderInstanceId,
): boolean {
  if (
    usageThresholdPercent === null ||
    !Number.isInteger(usageThresholdPercent) ||
    usageThresholdPercent < 1 ||
    usageThresholdPercent > 100
  ) {
    return false;
  }
  const selectedProvider = providers.find(
    (provider) => provider.instanceId === selectedInstanceId && isRunnableRoutingProvider(provider),
  );
  if (!selectedProvider) return false;

  const runnableIds = new Set(
    providers
      .filter(
        (provider) =>
          provider.driver === selectedProvider.driver && isRunnableRoutingProvider(provider),
      )
      .map((provider) => provider.instanceId),
  );
  const configuredIds = instanceIdsByDriver[selectedProvider.driver] ?? [];
  return (
    configuredIds.includes(selectedProvider.instanceId) &&
    new Set(configuredIds.filter((instanceId) => runnableIds.has(instanceId))).size >= 2
  );
}

export function routingModeAfterManualModelSelection(
  currentMode: ProviderRoutingMode,
  currentInstanceId: ProviderInstanceId,
  nextInstanceId: ProviderInstanceId,
): ProviderRoutingMode {
  return currentMode === "auto" && currentInstanceId !== nextInstanceId ? "fixed" : currentMode;
}

export function eligibleProjectDefaultProviderRoutingMode(
  configuredMode: ProviderRoutingMode,
  canEnableAuto: boolean,
): ProviderRoutingMode {
  return configuredMode === "auto" && !canEnableAuto ? "fixed" : configuredMode;
}

export function resolveNewTaskProviderRoutingMode(input: {
  /** Null means a new task; undefined means a legacy queued task without the field. */
  readonly editingMode: ProviderRoutingMode | null | undefined;
  readonly projectDefault: ProviderRoutingMode;
}): ProviderRoutingMode {
  return input.editingMode === null ? input.projectDefault : (input.editingMode ?? "fixed");
}

export function providerAccountRoutingConsentForSubmission(editingConsent: boolean | null): {
  readonly allowProviderAccountRouting?: true;
} {
  return editingConsent === false ? {} : { allowProviderAccountRouting: true };
}

export function modelSelectionsMatch(left: ModelSelection, right: ModelSelection): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.model === right.model &&
    JSON.stringify(left.options ?? null) === JSON.stringify(right.options ?? null)
  );
}

export function reconcileDraftModelSelectionAfterAutomaticRoute(input: {
  readonly providerRoutingMode: ProviderRoutingMode;
  readonly previousThreadSelection: ModelSelection;
  readonly currentThreadSelection: ModelSelection;
  readonly draftSelection?: ModelSelection;
  readonly draftSelectionIsExplicit?: boolean;
}): ModelSelection | undefined {
  if (
    input.providerRoutingMode === "auto" &&
    input.draftSelection !== undefined &&
    input.draftSelectionIsExplicit !== true &&
    !modelSelectionsMatch(input.previousThreadSelection, input.currentThreadSelection) &&
    modelSelectionsMatch(input.draftSelection, input.previousThreadSelection)
  ) {
    return input.currentThreadSelection;
  }
  return input.draftSelection;
}
