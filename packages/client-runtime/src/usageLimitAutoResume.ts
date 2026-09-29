import {
  USAGE_LIMIT_AUTO_RESUME_ACTIVITY_KIND,
  UsageLimitAutoResumePayload,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodePayload = Schema.decodeUnknownOption(UsageLimitAutoResumePayload);

/**
 * The usage-limit wait a thread is in, from the latest auto-resume row the
 * server recorded. Null when the thread is not waiting, or the row is stale
 * (past its deadline, when the server can no longer retry). A reset that has
 * passed is dropped, since attempts then just repeat. Clients show the wait
 * above the composer with a way to cancel.
 */
export function findUsageLimitAutoResumeWait(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
  nowMs: number,
): UsageLimitAutoResumePayload | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    if (activity.kind !== USAGE_LIMIT_AUTO_RESUME_ACTIVITY_KIND) continue;
    const payload = decodePayload(activity.payload);
    if (Option.isNone(payload) || payload.value.state !== "waiting") return null;
    const { resetAt, deadlineAt, ...wait } = payload.value;
    if (deadlineAt !== undefined && Date.parse(deadlineAt) <= nowMs) return null;
    return {
      ...wait,
      ...(resetAt === undefined || Date.parse(resetAt) <= nowMs ? {} : { resetAt }),
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
    };
  }
  return null;
}
