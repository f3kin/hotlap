import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";

import type { SettingsSearchItem } from "../settings/settingsSearch";

/**
 * Master workspace settings, owned here so upstream settings files only carry
 * one-line mount points. Both preferences are client-local and default off.
 */
export const MASTER_SETTINGS_SEARCH_ITEMS = [
  {
    id: "master-workspace",
    title: "Master workspace",
    to: "/settings/general",
    searchTerms: ["master pinned projects cards one-off sidebar personal"],
  },
  {
    id: "master-status-board",
    title: "Master status board",
    to: "/settings/general",
    searchTerms: ["master card status board threads workflow"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export const MASTER_SETTINGS_DEFAULTS = {
  masterWorkspaceEnabled: DEFAULT_UNIFIED_SETTINGS.masterWorkspaceEnabled,
  masterStatusBoardEnabled: DEFAULT_UNIFIED_SETTINGS.masterStatusBoardEnabled,
} as const;

/** Labels for "Restore defaults", in the order the rows render. */
export function getChangedMasterSettingLabels(
  settings: Pick<UnifiedSettings, keyof typeof MASTER_SETTINGS_DEFAULTS>,
): ReadonlyArray<string> {
  return [
    ...(settings.masterWorkspaceEnabled !== MASTER_SETTINGS_DEFAULTS.masterWorkspaceEnabled
      ? ["Master workspace"]
      : []),
    ...(settings.masterStatusBoardEnabled !== MASTER_SETTINGS_DEFAULTS.masterStatusBoardEnabled
      ? ["Master status board"]
      : []),
  ];
}
