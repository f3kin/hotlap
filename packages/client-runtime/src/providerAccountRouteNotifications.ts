import type { OrchestrationThreadActivity } from "@t3tools/contracts";

export interface ProviderAccountRouteNotification {
  readonly activityId: string;
  readonly kind: "success" | "error";
  readonly title: string;
  readonly description?: string;
}

export interface ProviderAccountRouteNotificationTracker {
  readonly observe: (
    threadKey: string | null,
    activities: ReadonlyArray<OrchestrationThreadActivity>,
    foreground: boolean,
  ) => ReadonlyArray<ProviderAccountRouteNotification>;
}

const ROUTE_KINDS = new Set(["provider.account.routed", "provider.account.route.failed"]);

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function stringValue(payload: Readonly<Record<string, unknown>>, keys: ReadonlyArray<string>) {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function present(activity: OrchestrationThreadActivity): ProviderAccountRouteNotification | null {
  const payload = record(activity.payload);
  if (activity.kind === "provider.account.route.failed") {
    const detail = stringValue(payload, ["detail", "error", "message"]);
    return {
      activityId: activity.id,
      kind: "error",
      title: activity.summary,
      ...(detail === null ? {} : { description: detail }),
    };
  }

  const provider = stringValue(payload, ["providerName", "providerLabel", "provider"]);
  const previous = stringValue(payload, [
    "previousProviderInstanceLabel",
    "previousAccountLabel",
    "previousAccountName",
  ]);
  const target = stringValue(payload, ["providerInstanceLabel", "accountLabel", "accountName"]);
  const initialPlacement =
    payload.initialPlacement === true || payload.reason === "initial-placement";

  // Initial placement is recorded in the timeline, but is not a completed
  // cross-account handoff and may precede the provider's first native auth response.
  if (initialPlacement) return null;
  if (previous !== null && target !== null) {
    return {
      activityId: activity.id,
      kind: "success",
      title: `Switched${provider === null ? "" : ` ${provider}:`} ${previous} → ${target}`,
      description: "Continuing this thread.",
    };
  }
  return {
    activityId: activity.id,
    kind: "success",
    title: activity.summary,
    description: "Continuing this thread.",
  };
}

/**
 * Tracks durable route activities for active thread detail streams. The first
 * observation of each thread is history, and background observations are
 * consumed without presentation so hydration, reconnects, and foregrounding
 * never replay old notifications.
 */
export function createProviderAccountRouteNotificationTracker(): ProviderAccountRouteNotificationTracker {
  const seenActivityIds = new Set<string>();
  let activeThreadKey: string | null = null;

  return {
    observe(threadKey, activities, foreground) {
      const relevant = activities.filter((activity) => ROUTE_KINDS.has(activity.kind));
      if (threadKey === null || !foreground) {
        activeThreadKey = null;
        for (const activity of relevant) seenActivityIds.add(activity.id);
        return [];
      }
      if (activeThreadKey !== threadKey) {
        activeThreadKey = threadKey;
        for (const activity of relevant) seenActivityIds.add(activity.id);
        return [];
      }

      const notifications: ProviderAccountRouteNotification[] = [];
      for (const activity of relevant) {
        if (seenActivityIds.has(activity.id)) continue;
        seenActivityIds.add(activity.id);
        const notification = present(activity);
        if (notification !== null) notifications.push(notification);
      }
      return notifications;
    },
  };
}
