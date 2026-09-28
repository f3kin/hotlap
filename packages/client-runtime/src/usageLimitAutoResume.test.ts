import { describe, expect, it } from "vite-plus/test";

import { findUsageLimitAutoResumeWait } from "./usageLimitAutoResume.ts";

const row = (payload: unknown) => ({ kind: "usage-limit.auto-resume", payload });
const waiting = {
  threadId: "thread-1",
  instanceId: "claudeAgent",
  state: "waiting",
  resetAt: "2026-09-28T03:00:00.000Z",
  deadlineAt: "2026-09-28T03:30:00.000Z",
};
const BEFORE_RESET = Date.parse("2026-09-28T02:00:00.000Z");

describe("findUsageLimitAutoResumeWait", () => {
  it("returns the wait while the latest row is waiting", () => {
    expect(
      findUsageLimitAutoResumeWait(
        [row({ ...waiting, state: "stopped" }), row(waiting)],
        BEFORE_RESET,
      ),
    ).toEqual(waiting);
  });

  it("returns null once the latest wait ended", () => {
    expect(
      findUsageLimitAutoResumeWait(
        [row(waiting), row({ ...waiting, state: "resumed" })],
        BEFORE_RESET,
      ),
    ).toBeNull();
  });

  it("ignores other activities and malformed rows", () => {
    expect(
      findUsageLimitAutoResumeWait(
        [{ kind: "runtime.error", payload: waiting }, row({ state: "waiting" })],
        BEFORE_RESET,
      ),
    ).toBeNull();
  });

  it("drops a reset that already passed", () => {
    const afterReset = Date.parse("2026-09-28T03:05:00.000Z");
    const { resetAt: _resetAt, ...withoutReset } = waiting;
    expect(findUsageLimitAutoResumeWait([row(waiting)], afterReset)).toEqual(withoutReset);
  });

  it("ignores a waiting row past its deadline", () => {
    // The server can no longer retry, so the row is stale.
    expect(findUsageLimitAutoResumeWait([row(waiting)], Date.parse(waiting.deadlineAt))).toBeNull();
  });
});
