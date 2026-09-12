import { describe, expect, it } from "@effect/vitest";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { resolveThreadStatus } from "./threadPresentation";

const idleThread = {
  hasActionableProposedPlan: false,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  interactionMode: "default",
  latestTurn: null,
  session: null,
} as EnvironmentThreadShell;

describe("resolveThreadStatus", () => {
  it("shows draft for a quiescent thread with unsent composer content", () => {
    expect(resolveThreadStatus(idleThread, true)).toMatchObject({
      kind: "draft",
      label: "Draft",
    });
  });

  it("keeps attention states ahead of an unsent draft", () => {
    expect(resolveThreadStatus({ ...idleThread, hasPendingApprovals: true }, true)).toMatchObject({
      kind: "pending-approval",
    });
  });
});
