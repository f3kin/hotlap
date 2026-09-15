import { isForkProviderSelectionUnlocked } from "@t3tools/client-runtime/state/threads";
import type { OrchestrationThreadShell } from "@t3tools/contracts";

import type { ProviderGroup } from "../../lib/modelOptions";

type ThreadProviderSelectionState = Pick<
  OrchestrationThreadShell,
  "forkedFrom" | "latestTurn" | "latestUserMessageAt" | "modelSelection" | "session"
>;

export function resolveThreadProviderGroups(
  thread: ThreadProviderSelectionState,
  providerGroups: ReadonlyArray<ProviderGroup>,
  queuedSubmissionCount: number,
): ReadonlyArray<ProviderGroup> {
  if (queuedSubmissionCount === 0 && isForkProviderSelectionUnlocked(thread)) {
    return providerGroups;
  }

  return providerGroups.filter((group) => group.providerKey === thread.modelSelection.instanceId);
}
