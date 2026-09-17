import { describe, expect, it } from "vite-plus/test";

import {
  readMasterWorkspaceShortcuts,
  toggleMasterWorkspaceShortcut,
} from "./MasterWorkspaceSidebar";

describe("Master workspace shortcuts", () => {
  it("keeps local shortcut data valid, deduplicated and scoped", () => {
    expect(readMasterWorkspaceShortcuts('{"not":"a list"}')).toEqual([]);
    expect(readMasterWorkspaceShortcuts("not json")).toEqual([]);
    expect(
      readMasterWorkspaceShortcuts('["env-a:master", "env-a:master", 2, "env-b:master"]'),
    ).toEqual(["env-a:master", "env-b:master"]);
  });

  it("toggles only the scoped Master key", () => {
    const a = "environment-a:master";
    const b = "environment-b:master";
    expect(toggleMasterWorkspaceShortcut([a], b)).toEqual([a, b]);
    expect(toggleMasterWorkspaceShortcut([a, b], a)).toEqual([b]);
  });
});
