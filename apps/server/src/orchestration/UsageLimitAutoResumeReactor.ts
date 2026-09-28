/**
 * Resumes a Claude thread whose turn failed on a usage limit.
 *
 * After the failure the thread waits, and every 5 minutes (plus once a minute
 * after the known reset) the reactor sends a hidden "Continue where you left
 * off." attempt. The Claude adapter keeps an attempt invisible until Claude
 * makes progress, and reports one that hits the limit again only as a quiet
 * `runtime.error` (`detail.autoResume`), so failed attempts leave no trace.
 * Works with one Claude instance whose login is swapped outside T3: the next
 * attempt simply runs on whatever login is current.
 *
 * The wait ends when an attempt gets through, the user acts on the thread,
 * Claude fails for another reason, or the deadline in
 * `UsageLimitAutoResumePolicy` passes. Each wait is one thread activity row,
 * updated in place, which is also what lets a restart pick the wait back up.
 */
import {
  CommandId,
  EventId,
  USAGE_LIMIT_AUTO_RESUME_ACTIVITY_KIND,
  UsageLimitAutoResumePayload,
  type OrchestrationEvent,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ThreadId,
  type TurnId,
  type UsageLimitAutoResumeState,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { readUsageLimitError } from "../provider/providerUsageLimits.ts";
import * as ProviderService from "../provider/Services/ProviderService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import {
  expiryReason,
  isAttemptStuck,
  isCycleExpired,
  scheduleNextAttempt,
  startCycle,
  withLatestReset,
  type AutoResumeCycle,
} from "./UsageLimitAutoResumePolicy.ts";

export class UsageLimitAutoResumeReactor extends Context.Service<
  UsageLimitAutoResumeReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/UsageLimitAutoResumeReactor") {}

const AUTO_RESUME_PROMPT = "Continue where you left off.";
/** Only the Claude adapter can hide a failed attempt, so only Claude threads resume. */
const CLAUDE_DRIVER = "claudeAgent";

const SUMMARY = {
  waiting: "Usage limit reached. Auto-resuming when it resets.",
  resumed: "Auto-resumed after usage limit",
  cancelled: "Auto-resume cancelled",
  gaveUpAfterReset: "Auto-resume stopped: still limited 30 min after reset",
  gaveUpUnknownReset: "Auto-resume stopped: still limited after 6 hours",
  gaveUpMaxWait: "Auto-resume stopped: still limited after 24 hours",
  tooFar: "Usage limit resets in more than 12 hours. Not auto-resuming.",
  lifted: "Usage limit lifted",
  turnedOff: "Auto-resume turned off",
  failed: "Auto-resume stopped: Claude failed",
} as const;

/** Endings where the thread is still stuck, shown as errors rather than notes. */
const ERROR_SUMMARIES: ReadonlySet<string> = new Set([
  SUMMARY.gaveUpAfterReset,
  SUMMARY.gaveUpUnknownReset,
  SUMMARY.gaveUpMaxWait,
  SUMMARY.failed,
]);

/** The row a wait writes to, fixed for the life of the wait. */
interface WaitRow {
  readonly activityId: EventId;
  readonly createdAt: string;
  readonly instanceId: ProviderInstanceId;
}

interface WaitingThread extends WaitRow {
  cycle: AutoResumeCycle;
  /** Set while a hidden attempt is out, until its outcome arrives. */
  attemptStartedAtMs: number | undefined;
  /**
   * The latest attempt's turn, kept after it fails: Claude can park a limited
   * attempt and still carry it on at the reset.
   */
  attemptTurnId: TurnId | undefined;
  /** A turn Claude started on its own while waiting, such as a background task. */
  selfStartedTurnId: TurnId | undefined;
}

type Input =
  | { readonly _tag: "restore" }
  | { readonly _tag: "tick" }
  | { readonly _tag: "runtime"; readonly event: ProviderRuntimeEvent }
  | { readonly _tag: "domain"; readonly event: OrchestrationEvent };

const GAVE_UP_SUMMARY = {
  unknownReset: SUMMARY.gaveUpUnknownReset,
  afterReset: SUMMARY.gaveUpAfterReset,
  maxWait: SUMMARY.gaveUpMaxWait,
} as const;

/**
 * User message times come from the client's clock, wait times from the server's.
 * A message counts as newer than a wait only past this margin.
 */
const CLIENT_CLOCK_SKEW_MS = 60_000;

const isAfter = (at: string | null, thresholdMs: number) =>
  at !== null && Date.parse(at) > thresholdMs;

const decodePayload = Schema.decodeUnknownOption(UsageLimitAutoResumePayload);
const toIso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providerService = yield* ProviderService.ProviderService;
  const settingsService = yield* ServerSettings.ServerSettingsService;

  const waitingThreads = new Map<ThreadId, WaitingThread>();
  let commandCount = 0;

  const writeRow = Effect.fn("UsageLimitAutoResumeReactor.writeRow")(function* (
    threadId: ThreadId,
    row: WaitRow,
    content: {
      readonly state: UsageLimitAutoResumeState;
      readonly summary: string;
      readonly resetAtMs: number | undefined;
      readonly deadlineAtMs?: number;
    },
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    const payload: UsageLimitAutoResumePayload = {
      threadId,
      instanceId: row.instanceId,
      state: content.state,
      ...(content.resetAtMs === undefined ? {} : { resetAt: toIso(content.resetAtMs) }),
      ...(content.deadlineAtMs === undefined ? {} : { deadlineAt: toIso(content.deadlineAtMs) }),
    };
    yield* engine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`${row.activityId}:${nowMs}:${++commandCount}`),
        threadId,
        activity: {
          id: row.activityId,
          tone: ERROR_SUMMARIES.has(content.summary) ? "error" : "info",
          kind: USAGE_LIMIT_AUTO_RESUME_ACTIVITY_KIND,
          summary: content.summary,
          payload,
          turnId: null,
          createdAt: row.createdAt,
        },
        createdAt: toIso(nowMs),
      })
      .pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("failed to record usage limit auto-resume", {
              threadId,
              cause: Cause.pretty(cause),
            }),
        ),
      );
  });

  /** Ends a wait with a final row. */
  const finish = (
    threadId: ThreadId,
    waiting: WaitingThread,
    state: Exclude<UsageLimitAutoResumeState, "waiting">,
    summary: string,
  ) => {
    waitingThreads.delete(threadId);
    return writeRow(threadId, waiting, { state, summary, resetAtMs: waiting.cycle.resetAtMs });
  };

  const handleUsageLimit = Effect.fn("UsageLimitAutoResumeReactor.handleUsageLimit")(function* (
    event: ProviderRuntimeEvent,
    limit: { readonly resetsAtMs: number | undefined; readonly autoResume: boolean },
  ) {
    if (event.provider !== CLAUDE_DRIVER) return;
    const nowMs = yield* Clock.currentTimeMillis;
    const reading = { nowMs, resetAtMs: limit.resetsAtMs };
    const waiting = waitingThreads.get(event.threadId);

    if (waiting !== undefined) {
      // A turn Claude started itself hit the limit too; the wait goes on.
      waiting.selfStartedTurnId = undefined;
      const cycle = withLatestReset(waiting.cycle, reading);
      if (cycle === null) return yield* finish(event.threadId, waiting, "stopped", SUMMARY.tooFar);
      const resetMoved = cycle.resetAtMs !== waiting.cycle.resetAtMs;
      // An older attempt replaced by the one now out says nothing about it.
      const staleAttempt = event.turnId !== undefined && event.turnId !== waiting.attemptTurnId;
      if (limit.autoResume && !staleAttempt) {
        waiting.attemptStartedAtMs = undefined;
        waiting.cycle = scheduleNextAttempt(cycle, nowMs);
      } else {
        waiting.cycle = cycle;
      }
      if (!resetMoved) return;
      // The banner, and a restart's restore, read the reset from the row.
      return yield* writeRow(event.threadId, waiting, {
        state: "waiting",
        summary: SUMMARY.waiting,
        resetAtMs: cycle.resetAtMs,
        deadlineAtMs: cycle.deadlineAtMs,
      });
    }

    // An attempt that outlived its wait (cancelled meanwhile) needs nothing.
    if (limit.autoResume || event.providerInstanceId === undefined) return;
    const settings = yield* settingsService.getSettings;
    if (!settings.autoResumeAfterUsageLimit) return;

    const row: WaitRow = {
      activityId: EventId.make(`usage-limit-auto-resume:${event.threadId}:${nowMs}`),
      createdAt: toIso(nowMs),
      instanceId: event.providerInstanceId,
    };
    const cycle = startCycle(reading);
    if (cycle === null) {
      return yield* writeRow(event.threadId, row, {
        state: "stopped",
        summary: SUMMARY.tooFar,
        resetAtMs: limit.resetsAtMs,
      });
    }
    waitingThreads.set(event.threadId, {
      ...row,
      cycle,
      attemptStartedAtMs: undefined,
      attemptTurnId: undefined,
      selfStartedTurnId: undefined,
    });
    yield* writeRow(event.threadId, row, {
      state: "waiting",
      summary: SUMMARY.waiting,
      resetAtMs: cycle.resetAtMs,
      deadlineAtMs: cycle.deadlineAtMs,
    });
  });

  const handleRuntimeEvent = Effect.fn("UsageLimitAutoResumeReactor.handleRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    const limit = readUsageLimitError(event);
    if (limit !== null) return yield* handleUsageLimit(event, limit);

    const waiting = waitingThreads.get(event.threadId);
    if (waiting === undefined) return;
    if (event.type === "turn.started") {
      // The adapter announces an attempt only once Claude makes progress.
      if (
        waiting.attemptStartedAtMs !== undefined ||
        (event.turnId !== undefined && event.turnId === waiting.attemptTurnId)
      ) {
        return yield* finish(event.threadId, waiting, "resumed", SUMMARY.resumed);
      }
      waiting.selfStartedTurnId = event.turnId;
      return;
    }
    if (
      event.type === "turn.completed" &&
      event.turnId !== undefined &&
      event.turnId === waiting.selfStartedTurnId
    ) {
      waiting.selfStartedTurnId = undefined;
      if (event.payload.state === "completed") {
        return yield* finish(event.threadId, waiting, "stopped", SUMMARY.lifted);
      }
      if (event.payload.state === "failed") {
        return yield* finish(event.threadId, waiting, "stopped", SUMMARY.failed);
      }
    }
  });

  /**
   * An attempt sent around the Stop can restart the session after the user's
   * stop ran, or sit parked until the reset, so it is stopped too. Unless the
   * user has sent a message since the Stop: the session is theirs again.
   */
  const cancelOnStop = Effect.fn("UsageLimitAutoResumeReactor.cancelOnStop")(function* (
    threadId: ThreadId,
    waiting: WaitingThread,
    stoppedAt: string,
  ) {
    if (waiting.attemptTurnId !== undefined) {
      const thread = yield* snapshots.getThreadShellById(threadId).pipe(Effect.option);
      const userMessagedSince =
        Option.isSome(thread) &&
        Option.isSome(thread.value) &&
        isAfter(thread.value.value.latestUserMessageAt, Date.parse(stoppedAt));
      if (!userMessagedSince) {
        yield* providerService.stopSession({ threadId }).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logWarning("failed to stop usage limit auto-resume attempt", {
                threadId,
                cause: Cause.pretty(cause),
              }),
          ),
        );
      }
    }
    yield* finish(threadId, waiting, "stopped", SUMMARY.cancelled);
  });

  const handleDomainEvent = (event: OrchestrationEvent) => {
    // Guarded stops only reap idle sessions; the next attempt restarts the session.
    if (event.type === "thread.session-stop-requested" && event.payload.onlyIfIdle === true) {
      return Effect.void;
    }
    switch (event.type) {
      case "thread.session-stop-requested": {
        const waiting = waitingThreads.get(event.payload.threadId);
        return waiting === undefined
          ? Effect.void
          : cancelOnStop(event.payload.threadId, waiting, event.payload.createdAt);
      }
      case "thread.turn-start-requested":
      case "thread.turn-interrupt-requested":
      case "thread.checkpoint-revert-requested":
      case "thread.archived":
      case "thread.settled": {
        const waiting = waitingThreads.get(event.payload.threadId);
        return waiting === undefined
          ? Effect.void
          : finish(event.payload.threadId, waiting, "stopped", SUMMARY.cancelled);
      }
      case "thread.deleted":
        waitingThreads.delete(event.payload.threadId);
        return Effect.void;
      default:
        return Effect.void;
    }
  };

  const attempt = Effect.fn("UsageLimitAutoResumeReactor.attempt")(function* (
    threadId: ThreadId,
    waiting: WaitingThread,
    nowMs: number,
  ) {
    const read = yield* snapshots.getThreadShellById(threadId).pipe(Effect.option);
    // A failed read retries on the next tick; only a missing thread ends the wait.
    if (Option.isNone(read)) return;
    const thread = read.value;
    if (Option.isNone(thread)) {
      waitingThreads.delete(threadId);
      return;
    }
    // Backs up the cancel event, which may still be queued or was lost to a restart.
    const userMessagedSince = isAfter(
      thread.value.latestUserMessageAt,
      Date.parse(waiting.createdAt) + CLIENT_CLOCK_SKEW_MS,
    );
    if (userMessagedSince || thread.value.modelSelection.instanceId !== waiting.instanceId) {
      return yield* finish(threadId, waiting, "stopped", SUMMARY.cancelled);
    }
    const status = thread.value.session?.status;
    if (
      thread.value.hasPendingApprovals ||
      thread.value.hasPendingUserInput ||
      status === "running" ||
      status === "starting"
    ) {
      return;
    }
    waiting.attemptStartedAtMs = nowMs;
    waiting.cycle = scheduleNextAttempt(waiting.cycle, nowMs);
    yield* providerService
      .sendTurn({
        threadId,
        input: AUTO_RESUME_PROMPT,
        interactionMode: thread.value.interactionMode,
        autoResume: true,
      })
      .pipe(
        Effect.tap((started) =>
          Effect.sync(() => {
            waiting.attemptTurnId = started.turnId;
          }),
        ),
        Effect.timeout("2 minutes"),
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => {
            waiting.attemptStartedAtMs = undefined;
            return Effect.logInfo("usage limit auto-resume attempt not sent", {
              threadId,
              cause: Cause.pretty(cause),
            });
          },
        ),
      );
  });

  const tick = Effect.fn("UsageLimitAutoResumeReactor.tick")(function* () {
    const settings = yield* settingsService.getSettings;
    const nowMs = yield* Clock.currentTimeMillis;
    // Snapshot: finish removes entries while the loop yields.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const [threadId, waiting] of [...waitingThreads]) {
      if (!settings.autoResumeAfterUsageLimit) {
        yield* finish(threadId, waiting, "stopped", SUMMARY.turnedOff);
        continue;
      }
      if (waiting.attemptStartedAtMs !== undefined) {
        // Wait for the attempt's outcome before judging the cycle.
        if (!isAttemptStuck(waiting.attemptStartedAtMs, nowMs)) continue;
        waiting.attemptStartedAtMs = undefined;
      }
      if (isCycleExpired(waiting.cycle, nowMs)) {
        yield* finish(threadId, waiting, "stopped", GAVE_UP_SUMMARY[expiryReason(waiting.cycle)]);
        continue;
      }
      if (nowMs >= waiting.cycle.nextAttemptAtMs) {
        yield* attempt(threadId, waiting, nowMs);
      }
    }
  });

  /** Picks up waits a previous server process left open. */
  const restore = Effect.fn("UsageLimitAutoResumeReactor.restore")(function* () {
    const rows = yield* snapshots.listActivitiesByKind(USAGE_LIMIT_AUTO_RESUME_ACTIVITY_KIND);
    const nowMs = yield* Clock.currentTimeMillis;
    const latestByThread = new Map<ThreadId, (typeof rows)[number]>();
    for (const row of rows) {
      const payload = decodePayload(row.payload);
      if (Option.isNone(payload)) continue;
      const latest = latestByThread.get(payload.value.threadId);
      if (latest === undefined || row.createdAt > latest.createdAt) {
        latestByThread.set(payload.value.threadId, row);
      }
    }
    for (const [threadId, row] of latestByThread) {
      const payload = decodePayload(row.payload);
      if (
        Option.isNone(payload) ||
        payload.value.state !== "waiting" ||
        payload.value.deadlineAt === undefined
      ) {
        continue;
      }
      waitingThreads.set(threadId, {
        activityId: row.id,
        createdAt: row.createdAt,
        instanceId: payload.value.instanceId,
        cycle: {
          startedAtMs: Date.parse(row.createdAt),
          resetAtMs:
            payload.value.resetAt === undefined ? undefined : Date.parse(payload.value.resetAt),
          deadlineAtMs: Date.parse(payload.value.deadlineAt),
          // A restart continuation, if any, gets the first minute.
          nextAttemptAtMs: nowMs + 60_000,
        },
        attemptStartedAtMs: undefined,
        attemptTurnId: undefined,
        selfStartedTurnId: undefined,
      });
    }
  });

  const process = (input: Input) => {
    switch (input._tag) {
      case "restore":
        return restore();
      case "tick":
        return tick();
      case "runtime":
        return handleRuntimeEvent(input.event);
      case "domain":
        return handleDomainEvent(input.event);
    }
  };

  const worker = yield* makeDrainableWorker((input: Input) =>
    process(input).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("usage limit auto-resume step failed", {
            input: input._tag,
            cause: Cause.pretty(cause),
          }),
      ),
    ),
  );

  const start: UsageLimitAutoResumeReactor["Service"]["start"] = Effect.fn(
    "UsageLimitAutoResumeReactor.start",
  )(function* () {
    const domainEvents = yield* engine.subscribeDomainEvents;
    yield* forkParked(
      Stream.runForEach(providerService.streamEvents, (event) =>
        event.type === "runtime.error" ||
        event.type === "turn.started" ||
        event.type === "turn.completed"
          ? worker.enqueue({ _tag: "runtime", event })
          : Effect.void,
      ),
    );
    yield* forkParked(
      Stream.runForEach(domainEvents, (event) => worker.enqueue({ _tag: "domain", event })),
    );
    yield* forkParked(
      worker.enqueue({ _tag: "restore" }).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            yield* worker.enqueue({ _tag: "tick" });
            yield* worker.drain;
          }).pipe(Effect.repeat(Schedule.spaced("30 seconds"))),
        ),
        Effect.asVoid,
      ),
    );
  });

  return { start, drain: worker.drain } satisfies UsageLimitAutoResumeReactor["Service"];
});

export const layer = Layer.effect(UsageLimitAutoResumeReactor, make);
