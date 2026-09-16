import { describe, expect, it } from "@effect/vitest";

import {
  isProviderAccountConfirmedUnusable,
  selectAutomaticProviderAccount,
  type ProviderAccountRoutingInput,
  type ProviderAccountRoutingProvider,
  type ProviderAccountRoutingUsageWindow,
} from "./providerAccountRouting.ts";

const NOW = Date.parse("2026-09-15T00:00:00.000Z");
const FRESH = "2026-09-14T23:59:00.000Z";
const FUTURE_RESET = "2026-09-22T00:00:00.000Z";

function usageWindow(
  id: string,
  kind: ProviderAccountRoutingUsageWindow["kind"],
  usedPercent: number,
  resetsAt: string | null | undefined = FUTURE_RESET,
): ProviderAccountRoutingUsageWindow {
  return { id, kind, usedPercent, ...(resetsAt ? { resetsAt } : {}) };
}

function codexProvider(
  instanceId: string,
  weeklyUsedPercent: number,
  overrides: Partial<ProviderAccountRoutingProvider> = {},
): ProviderAccountRoutingProvider {
  return {
    instanceId,
    driver: "codex",
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    continuation: { groupKey: "codex:home:shared" },
    models: [
      {
        slug: "gpt-6-astra",
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              type: "select",
              options: [{ id: "high" }, { id: "max" }],
            },
            { id: "fastMode", type: "boolean" },
          ],
        },
      },
    ],
    usageLimits: {
      checkedAt: FRESH,
      windows: [usageWindow("secondary", "weekly", weeklyUsedPercent)],
    },
    ...overrides,
  };
}

function claudeProvider(
  instanceId: string,
  sessionUsedPercent: number,
  weeklyUsedPercent: number,
  overrides: Partial<ProviderAccountRoutingProvider> = {},
): ProviderAccountRoutingProvider {
  return {
    instanceId,
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    continuation: { groupKey: `claude:home:${instanceId}` },
    models: [{ slug: "claude-opus", capabilities: { optionDescriptors: [] } }],
    usageLimits: {
      checkedAt: FRESH,
      windows: [
        usageWindow("five_hour", "session", sessionUsedPercent),
        usageWindow("seven_day", "weekly", weeklyUsedPercent),
      ],
    },
    ...overrides,
  };
}

function input(overrides: Partial<ProviderAccountRoutingInput> = {}): ProviderAccountRoutingInput {
  return {
    routingMode: "auto",
    instanceIds: ["codex-personal", "codex-work"],
    usageThresholdPercent: 80,
    threadHasStarted: true,
    modelSelection: {
      instanceId: "codex-personal",
      model: "gpt-6-astra",
      options: [{ id: "reasoningEffort", value: "high" }],
    },
    providers: [codexProvider("codex-personal", 80), codexProvider("codex-work", 20)],
    nowMs: NOW,
    maxUsageAgeMs: 5 * 60_000,
    ...overrides,
  };
}

function withoutUsageLimits(
  provider: ProviderAccountRoutingProvider,
): ProviderAccountRoutingProvider {
  const { usageLimits: _usageLimits, ...rest } = provider;
  return rest;
}

function withoutContinuation(
  provider: ProviderAccountRoutingProvider,
): ProviderAccountRoutingProvider {
  const { continuation: _continuation, ...rest } = provider;
  return rest;
}

describe("selectAutomaticProviderAccount", () => {
  it("selects a runnable compatible Codex account when weekly usage reaches the chosen threshold", () => {
    expect(selectAutomaticProviderAccount(input({ threadHasStarted: true }))).toEqual({
      targetInstanceIds: ["codex-work"],
      reason: "usage-threshold",
    });
  });

  it("uses the user's threshold instead of a fixed threshold", () => {
    expect(
      selectAutomaticProviderAccount(
        input({
          usageThresholdPercent: 50,
          providers: [codexProvider("codex-personal", 50), codexProvider("codex-work", 20)],
        }),
      ),
    ).toEqual({ targetInstanceIds: ["codex-work"], reason: "usage-threshold" });
    expect(
      selectAutomaticProviderAccount(
        input({
          usageThresholdPercent: 90,
          providers: [codexProvider("codex-personal", 89.99), codexProvider("codex-work", 20)],
        }),
      ),
    ).toBeNull();
  });

  it.each([null, 0, 1.5, 101])("does nothing without a valid threshold (%s)", (threshold) => {
    expect(selectAutomaticProviderAccount(input({ usageThresholdPercent: threshold }))).toBeNull();
  });

  it("does nothing for a fixed thread", () => {
    expect(selectAutomaticProviderAccount(input({ routingMode: "fixed" }))).toBeNull();
  });

  it("uses only Codex weekly usage as the trigger", () => {
    const current = codexProvider("codex-personal", 20, {
      usageLimits: {
        checkedAt: FRESH,
        windows: [usageWindow("primary", "session", 100), usageWindow("secondary", "weekly", 20)],
      },
    });
    expect(
      selectAutomaticProviderAccount(
        input({ providers: [current, codexProvider("codex-work", 20)] }),
      ),
    ).toBeNull();
  });

  it.each([
    ["stale snapshot", "2026-09-14T23:54:59.999Z", FUTURE_RESET],
    ["future snapshot", "2026-09-15T00:00:00.001Z", FUTURE_RESET],
    ["missing reset", FRESH, null],
    ["expired reset", FRESH, "2026-09-15T00:00:00.000Z"],
  ] as const)("stays on the current account for a %s", (_name, checkedAt, resetsAt) => {
    const current = codexProvider("codex-personal", 80, {
      usageLimits: {
        checkedAt,
        windows: [usageWindow("secondary", "weekly", 80, resetsAt)],
      },
    });
    expect(
      selectAutomaticProviderAccount(
        input({ providers: [current, codexProvider("codex-work", 20)] }),
      ),
    ).toBeNull();
  });

  it.each([
    [
      "stale usage",
      {
        checkedAt: "2026-09-14T23:54:59.999Z",
        windows: [usageWindow("secondary", "weekly", 20)],
      },
    ],
    [
      "expired reset",
      {
        checkedAt: FRESH,
        windows: [usageWindow("secondary", "weekly", 20, "2026-09-14T00:00:00.000Z")],
      },
    ],
    [
      "missing reset",
      {
        checkedAt: FRESH,
        windows: [usageWindow("secondary", "weekly", 20, null)],
      },
    ],
  ] as const)("rejects a target with %s", (_name, usageLimits) => {
    const target = codexProvider("codex-work", 20, { usageLimits });
    expect(
      selectAutomaticProviderAccount(
        input({ providers: [codexProvider("codex-personal", 80), target] }),
      ),
    ).toBeNull();
  });

  it("rejects a target with missing usage", () => {
    const target = withoutUsageLimits(codexProvider("codex-work", 20));
    expect(
      selectAutomaticProviderAccount(
        input({ providers: [codexProvider("codex-personal", 80), target] }),
      ),
    ).toBeNull();
  });

  it("stays when the configured target is not observed", () => {
    expect(
      selectAutomaticProviderAccount(input({ providers: [codexProvider("codex-personal", 80)] })),
    ).toBeNull();
  });

  it("stays when the current account is not in the configured pool", () => {
    expect(
      selectAutomaticProviderAccount(input({ instanceIds: ["codex-work", "codex-backup"] })),
    ).toBeNull();
  });

  it("requires two distinct accounts in the pool", () => {
    expect(
      selectAutomaticProviderAccount(input({ instanceIds: ["codex-personal", "codex-personal"] })),
    ).toBeNull();
  });

  it("ranks every eligible target by earliest weekly reset, then usage, then stable id", () => {
    const providerWithUsage = (instanceId: string, usedPercent: number, resetsAt: string) =>
      codexProvider(instanceId, usedPercent, {
        usageLimits: {
          checkedAt: FRESH,
          windows: [usageWindow("secondary", "weekly", usedPercent, resetsAt)],
        },
      });
    expect(
      selectAutomaticProviderAccount(
        input({
          instanceIds: ["codex-z", "codex-current", "codex-b", "codex-a"],
          modelSelection: {
            instanceId: "codex-current",
            model: "gpt-6-astra",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
          providers: [
            providerWithUsage("codex-current", 80, "2026-09-24T00:00:00.000Z"),
            providerWithUsage("codex-z", 5, "2026-09-21T00:00:00.000Z"),
            providerWithUsage("codex-b", 20, "2026-09-20T00:00:00.000Z"),
            providerWithUsage("codex-a", 20, "2026-09-20T00:00:00.000Z"),
          ],
        }),
      ),
    ).toEqual({
      targetInstanceIds: ["codex-a", "codex-b", "codex-z"],
      reason: "usage-threshold",
    });
  });

  it("chooses the earliest-reset eligible account for a new thread", () => {
    const later = "2026-09-24T00:00:00.000Z";
    const earlier = "2026-09-20T00:00:00.000Z";
    expect(
      selectAutomaticProviderAccount(
        input({
          threadHasStarted: false,
          providers: [
            codexProvider("codex-personal", 20, {
              usageLimits: {
                checkedAt: FRESH,
                windows: [usageWindow("secondary", "weekly", 20, later)],
              },
            }),
            codexProvider("codex-work", 30, {
              usageLimits: {
                checkedAt: FRESH,
                windows: [usageWindow("secondary", "weekly", 30, earlier)],
              },
            }),
          ],
        }),
      ),
    ).toEqual({ targetInstanceIds: ["codex-work"], reason: "initial-placement" });
  });

  it("keeps a new thread on its current account when it ranks first", () => {
    expect(
      selectAutomaticProviderAccount(
        input({
          threadHasStarted: false,
          providers: [codexProvider("codex-personal", 10), codexProvider("codex-work", 20)],
        }),
      ),
    ).toBeNull();
  });

  it("does not select a target at the chosen threshold", () => {
    expect(
      selectAutomaticProviderAccount(
        input({
          providers: [codexProvider("codex-personal", 80), codexProvider("codex-work", 80)],
        }),
      ),
    ).toBeNull();
  });

  it("routes away from a confirmed unusable current account before the threshold", () => {
    expect(
      selectAutomaticProviderAccount(
        input({
          providers: [
            codexProvider("codex-personal", 20, { availability: "unavailable" }),
            codexProvider("codex-work", 20),
          ],
        }),
      ),
    ).toEqual({ targetInstanceIds: ["codex-work"], reason: "current-unusable" });
  });

  it.each([
    ["disabled", { enabled: false }],
    ["not installed", { installed: false }],
    ["not ready", { status: "warning" }],
    ["not authenticated", { auth: { status: "unauthenticated" } }],
    ["unavailable", { availability: "unavailable" }],
  ] as const)("rejects a %s target", (_name, targetOverrides) => {
    expect(
      selectAutomaticProviderAccount(
        input({
          providers: [
            codexProvider("codex-personal", 80),
            codexProvider("codex-work", 20, targetOverrides),
          ],
        }),
      ),
    ).toBeNull();
  });

  it.each([
    ["missing model", [{ slug: "gpt-other", capabilities: null }]],
    ["missing option", [{ slug: "gpt-6-astra", capabilities: { optionDescriptors: [] } }]],
    [
      "incompatible option value",
      [
        {
          slug: "gpt-6-astra",
          capabilities: {
            optionDescriptors: [
              { id: "reasoningEffort", type: "select" as const, options: [{ id: "low" }] },
            ],
          },
        },
      ],
    ],
  ] as const)("rejects a target with a %s", (_name, models) => {
    expect(
      selectAutomaticProviderAccount(
        input({
          providers: [
            codexProvider("codex-personal", 80),
            codexProvider("codex-work", 20, { models }),
          ],
        }),
      ),
    ).toBeNull();
  });

  it("requires exact Codex continuation groups for a started thread", () => {
    const route = (groupKey: string | undefined) =>
      selectAutomaticProviderAccount(
        input({
          threadHasStarted: true,
          providers: [
            codexProvider("codex-personal", 80),
            groupKey
              ? codexProvider("codex-work", 20, { continuation: { groupKey } })
              : withoutContinuation(codexProvider("codex-work", 20)),
          ],
        }),
      );
    expect(route("codex:home:other")).toBeNull();
    expect(route(undefined)).toBeNull();
    expect(route("codex:home:shared")).toEqual({
      targetInstanceIds: ["codex-work"],
      reason: "usage-threshold",
    });
  });

  it("routes a new Claude thread when either account-wide limit reaches the threshold", () => {
    const claudeInput = (session: number, weekly: number) =>
      input({
        threadHasStarted: false,
        instanceIds: ["claude-personal", "claude-work"],
        modelSelection: { instanceId: "claude-personal", model: "claude-opus" },
        providers: [
          claudeProvider("claude-personal", session, weekly),
          claudeProvider("claude-work", 20, 20),
        ],
      });
    expect(selectAutomaticProviderAccount(claudeInput(80, 20))).toEqual({
      targetInstanceIds: ["claude-work"],
      reason: "initial-placement",
    });
    expect(selectAutomaticProviderAccount(claudeInput(20, 80))).toEqual({
      targetInstanceIds: ["claude-work"],
      reason: "initial-placement",
    });
  });

  it("does not route a started Claude thread until safe transcript handoff is proven", () => {
    expect(
      selectAutomaticProviderAccount(
        input({
          instanceIds: ["claude-personal", "claude-work"],
          modelSelection: { instanceId: "claude-personal", model: "claude-opus" },
          providers: [
            claudeProvider("claude-personal", 80, 20),
            claudeProvider("claude-work", 20, 20),
          ],
        }),
      ),
    ).toBeNull();
  });

  it.each(["current", "target"] as const)(
    "excludes a %s Claude account when either account-wide window is missing",
    (incompleteAccount) => {
      const incomplete = claudeProvider(
        incompleteAccount === "current" ? "claude-personal" : "claude-work",
        incompleteAccount === "current" ? 80 : 20,
        20,
        {
          usageLimits: {
            checkedAt: FRESH,
            windows: [
              usageWindow("five_hour", "session", incompleteAccount === "current" ? 80 : 20),
            ],
          },
        },
      );
      const decision = selectAutomaticProviderAccount(
        input({
          threadHasStarted: false,
          instanceIds: ["claude-personal", "claude-work"],
          modelSelection: { instanceId: "claude-personal", model: "claude-opus" },
          providers: [
            incompleteAccount === "current"
              ? incomplete
              : claudeProvider("claude-personal", 80, 20),
            incompleteAccount === "target" ? incomplete : claudeProvider("claude-work", 20, 20),
          ],
        }),
      );
      expect(decision).toEqual(
        incompleteAccount === "current"
          ? { targetInstanceIds: ["claude-work"], reason: "initial-placement" }
          : null,
      );
    },
  );

  it("ignores Claude model-scoped and other windows", () => {
    const current = claudeProvider("claude-personal", 20, 20, {
      usageLimits: {
        checkedAt: FRESH,
        windows: [
          usageWindow("five_hour", "session", 20),
          usageWindow("seven_day", "weekly", 20),
          usageWindow("seven_day_fable", "weekly", 100),
          usageWindow("extra", "other", 100),
        ],
      },
    });
    expect(
      selectAutomaticProviderAccount(
        input({
          threadHasStarted: false,
          instanceIds: ["claude-personal", "claude-work"],
          modelSelection: { instanceId: "claude-personal", model: "claude-opus" },
          providers: [current, claudeProvider("claude-work", 20, 20)],
        }),
      ),
    ).toBeNull();
  });

  it("requires both relevant target windows to remain below the chosen threshold", () => {
    expect(
      selectAutomaticProviderAccount(
        input({
          threadHasStarted: false,
          instanceIds: ["claude-personal", "claude-work"],
          modelSelection: { instanceId: "claude-personal", model: "claude-opus" },
          providers: [
            claudeProvider("claude-personal", 80, 20),
            claudeProvider("claude-work", 20, 80),
          ],
        }),
      ),
    ).toBeNull();
  });
});

describe("isProviderAccountConfirmedUnusable", () => {
  const timing = { nowMs: NOW, maxUsageAgeMs: 5 * 60_000 };

  it.each([
    ["disabled", { enabled: false }],
    ["not installed", { installed: false }],
    ["not ready", { status: "warning" }],
    ["signed out", { auth: { status: "unauthenticated" } }],
    ["unavailable", { availability: "unavailable" }],
  ] as const)("confirms an account is unusable when it is %s", (_label, overrides) => {
    expect(isProviderAccountConfirmedUnusable(codexProvider("codex", 20, overrides), timing)).toBe(
      true,
    );
  });

  it("confirms fresh exhausted Codex and Claude account-wide limits", () => {
    expect(isProviderAccountConfirmedUnusable(codexProvider("codex", 100), timing)).toBe(true);
    expect(isProviderAccountConfirmedUnusable(claudeProvider("claude", 100, 20), timing)).toBe(
      true,
    );
    expect(isProviderAccountConfirmedUnusable(claudeProvider("claude", 20, 100), timing)).toBe(
      true,
    );
  });

  it("does not treat missing or stale usage as proof that an otherwise ready account is unusable", () => {
    expect(
      isProviderAccountConfirmedUnusable(
        withoutUsageLimits(codexProvider("codex-missing", 100)),
        timing,
      ),
    ).toBe(false);
    expect(
      isProviderAccountConfirmedUnusable(
        codexProvider("codex-stale", 100, {
          usageLimits: {
            checkedAt: "2026-09-14T23:54:59.999Z",
            windows: [usageWindow("secondary", "weekly", 100)],
          },
        }),
        timing,
      ),
    ).toBe(false);
  });
});
