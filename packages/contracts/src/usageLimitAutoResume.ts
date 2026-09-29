import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Thread activity the server writes while it resumes a thread after a provider
 * usage limit. One row per wait, updated in place under a fixed id, so every
 * client renders the latest state and the server can pick a wait back up after
 * a restart.
 */
export const USAGE_LIMIT_AUTO_RESUME_ACTIVITY_KIND = "usage-limit.auto-resume";

export const UsageLimitAutoResumeState = Schema.Literals(["waiting", "resumed", "stopped"]);
export type UsageLimitAutoResumeState = typeof UsageLimitAutoResumeState.Type;

export const UsageLimitAutoResumePayload = Schema.Struct({
  threadId: ThreadId,
  /** The provider instance that hit the limit; moving the thread off it cancels the wait. */
  instanceId: ProviderInstanceId,
  state: UsageLimitAutoResumeState,
  /** Latest known reset, when the provider reported one. */
  resetAt: Schema.optional(IsoDateTime),
  /** When the server gives up. Present while waiting. */
  deadlineAt: Schema.optional(IsoDateTime),
});
export type UsageLimitAutoResumePayload = typeof UsageLimitAutoResumePayload.Type;
