import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createProviderAccountRouteNotificationTracker } from "./providerAccountRouteNotifications.js";

function activity(
  id: string,
  kind: string,
  payload: unknown,
  summary = "Switched provider account",
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: kind.endsWith("failed") ? "error" : "info",
    kind,
    summary,
    payload,
    turnId: null,
    createdAt: "2026-09-16T00:00:00.000Z",
  };
}

describe("provider account route notifications", () => {
  it("baselines history, then presents a new handoff once", () => {
    const tracker = createProviderAccountRouteNotificationTracker();
    const historical = activity("route-old", "provider.account.routed", {
      providerName: "Codex",
      previousProviderInstanceLabel: "Personal",
      providerInstanceLabel: "Work",
    });
    const routed = activity("route-new", "provider.account.routed", {
      providerName: "Codex",
      previousProviderInstanceLabel: "Personal",
      providerInstanceLabel: "Work",
    });

    expect(tracker.observe("env:thread", [historical], true)).toEqual([]);
    expect(tracker.observe("env:thread", [historical, routed], true)).toEqual([
      {
        activityId: "route-new",
        kind: "success",
        title: "Switched Codex: Personal → Work",
        description: "Continuing this thread.",
      },
    ]);
    expect(tracker.observe("env:thread", [historical, routed], true)).toEqual([]);
  });

  it("consumes events received in the background without presenting them later", () => {
    const tracker = createProviderAccountRouteNotificationTracker();
    const routed = activity("route-new", "provider.account.routed", {
      previousProviderInstanceLabel: "Personal",
      providerInstanceLabel: "Work",
    });

    tracker.observe("env:thread", [], true);
    expect(tracker.observe("env:thread", [routed], false)).toEqual([]);
    expect(tracker.observe("env:thread", [routed], true)).toEqual([]);
  });

  it("keeps initial placement in the timeline and falls back safely for incomplete payloads", () => {
    const tracker = createProviderAccountRouteNotificationTracker();
    tracker.observe("env:thread", [], true);

    expect(
      tracker.observe(
        "env:thread",
        [
          activity("initial", "provider.account.routed", {
            initialPlacement: true,
            providerInstanceLabel: "Work",
          }),
          activity(
            "fallback",
            "provider.account.routed",
            {
              previousProviderInstanceId: "claude-personal",
              providerInstanceId: "claude-work",
            },
            "Account changed",
          ),
        ],
        true,
      ),
    ).toEqual([
      {
        activityId: "fallback",
        kind: "success",
        title: "Account changed",
        description: "Continuing this thread.",
      },
    ]);
  });

  it("presents route failures as errors with defensive detail parsing", () => {
    const tracker = createProviderAccountRouteNotificationTracker();
    tracker.observe("env:thread", [], true);

    expect(
      tracker.observe(
        "env:thread",
        [
          activity(
            "failed",
            "provider.account.route.failed",
            { detail: "Work account could not authenticate." },
            "Provider account switch failed",
          ),
        ],
        true,
      ),
    ).toEqual([
      {
        activityId: "failed",
        kind: "error",
        title: "Provider account switch failed",
        description: "Work account could not authenticate.",
      },
    ]);
  });

  it("baselines each active thread independently and survives reconnect snapshots", () => {
    const tracker = createProviderAccountRouteNotificationTracker();
    const first = activity("route-a", "provider.account.routed", {
      previousProviderInstanceLabel: "Personal",
      providerInstanceLabel: "Work",
    });

    expect(tracker.observe("env:thread-a", [first], true)).toEqual([]);
    expect(tracker.observe("env:thread-b", [first], true)).toEqual([]);
    expect(tracker.observe("env:thread-a", [], true)).toEqual([]);
    expect(tracker.observe("env:thread-a", [first], true)).toEqual([]);
  });

  it("does not replay a route that happened while the thread was inactive or reconnecting", () => {
    const tracker = createProviderAccountRouteNotificationTracker();
    const routed = activity("route-away", "provider.account.routed", {
      previousProviderInstanceLabel: "Personal",
      providerInstanceLabel: "Work",
    });

    expect(tracker.observe("env:thread-a", [], true)).toEqual([]);
    expect(tracker.observe(null, [], true)).toEqual([]);
    expect(tracker.observe("env:thread-a", [routed], true)).toEqual([]);
    expect(tracker.observe(null, [], true)).toEqual([]);
    expect(tracker.observe("env:thread-a", [routed], true)).toEqual([]);
  });
});
