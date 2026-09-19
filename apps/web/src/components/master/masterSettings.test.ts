import { DEFAULT_CLIENT_SETTINGS, DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { getSettingsSearchTargetScope, searchSettings } from "../settings/settingsSearch";
import { getChangedMasterSettingLabels } from "./masterSettings";

describe("Master settings", () => {
  it("default off, so the upstream sidebar and chat layout are untouched", () => {
    expect(DEFAULT_CLIENT_SETTINGS.masterWorkspaceEnabled).toBe(false);
    expect(DEFAULT_CLIENT_SETTINGS.masterStatusBoardEnabled).toBe(false);
    expect(getChangedMasterSettingLabels(DEFAULT_UNIFIED_SETTINGS)).toEqual([]);
  });

  it("lists each changed preference for Restore defaults", () => {
    expect(
      getChangedMasterSettingLabels({
        masterWorkspaceEnabled: true,
        masterStatusBoardEnabled: true,
      }),
    ).toEqual(["Master workspace", "Master status board"]);
  });

  it("is findable from settings search as unscoped client rows", () => {
    expect(searchSettings("master card workflow")[0]).toMatchObject({
      id: "master-status-board",
      to: "/settings/general",
    });
    expect(searchSettings("personal master sidebar")[0]).toMatchObject({
      id: "master-workspace",
      to: "/settings/general",
    });
    expect(getSettingsSearchTargetScope("master-workspace")).toEqual({
      title: "Master workspace",
      scope: null,
    });
  });
});
