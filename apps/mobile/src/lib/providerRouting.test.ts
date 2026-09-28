import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  providerRoutingAutoBlocker,
  eligibleProjectDefaultProviderRoutingMode,
  providerAccountRoutingConsentForSubmission,
  reconcileDraftModelSelectionAfterAutomaticRoute,
  resolveProviderRoutingModeForSubmission,
  resolveNewTaskProviderRoutingMode,
  routingModeAfterManualModelSelection,
  shouldClearProviderRoutingIntent,
} from "./providerRouting";

const codexOne = ProviderInstanceId.make("codex-one");
const codexTwo = ProviderInstanceId.make("codex-two");
const claudeOne = ProviderInstanceId.make("claude-one");

function provider(instanceId: string, overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-15T00:00:00.000Z",
    version: "1.0.0",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("routingModeAfterManualModelSelection", () => {
  it("pins automatic routing when the user picks another account", () => {
    expect(routingModeAfterManualModelSelection("auto", codexOne, codexTwo)).toBe("fixed");
  });

  it("preserves automatic routing for model and option changes on the same account", () => {
    expect(routingModeAfterManualModelSelection("auto", codexOne, codexOne)).toBe("auto");
  });

  it("keeps fixed routing fixed", () => {
    expect(routingModeAfterManualModelSelection("fixed", codexOne, codexTwo)).toBe("fixed");
  });
});

describe("resolveProviderRoutingModeForSubmission", () => {
  it("uses the pending Fixed draft intent before the server projection catches up", () => {
    expect(
      resolveProviderRoutingModeForSubmission({
        draftMode: "fixed",
        authoritativeMode: "auto",
        authoritativeInstanceId: codexOne,
        selectedInstanceId: codexTwo,
      }),
    ).toBe("fixed");
  });

  it("uses the pending Auto draft intent before the server projection catches up", () => {
    expect(
      resolveProviderRoutingModeForSubmission({
        draftMode: "auto",
        authoritativeMode: "fixed",
        authoritativeInstanceId: codexOne,
        selectedInstanceId: codexOne,
      }),
    ).toBe("auto");
  });

  it("pins an account change when there is no pending routing intent", () => {
    expect(
      resolveProviderRoutingModeForSubmission({
        authoritativeMode: "auto",
        authoritativeInstanceId: codexOne,
        selectedInstanceId: codexTwo,
      }),
    ).toBe("fixed");
  });

  it("keeps Auto for a Claude thread, which can now switch accounts after starting", () => {
    expect(
      resolveProviderRoutingModeForSubmission({
        draftMode: "auto",
        authoritativeMode: "fixed",
        authoritativeInstanceId: claudeOne,
        selectedInstanceId: claudeOne,
      }),
    ).toBe("auto");
    expect(
      resolveProviderRoutingModeForSubmission({
        authoritativeMode: "auto",
        authoritativeInstanceId: claudeOne,
        selectedInstanceId: claudeOne,
      }),
    ).toBe("auto");
  });
});

describe("shouldClearProviderRoutingIntent", () => {
  it("keeps an intent while its save is in flight", () => {
    expect(
      shouldClearProviderRoutingIntent({
        saveStatus: "pending",
        intendedMode: "auto",
        authoritativeMode: "fixed",
      }),
    ).toBe(false);
  });

  it("clears a leftover intent once the server shows the same mode", () => {
    expect(
      shouldClearProviderRoutingIntent({
        saveStatus: "none",
        intendedMode: "fixed",
        authoritativeMode: "fixed",
      }),
    ).toBe(true);
    expect(
      shouldClearProviderRoutingIntent({
        saveStatus: "none",
        intendedMode: "auto",
        authoritativeMode: "fixed",
      }),
    ).toBe(false);
  });

  it("has nothing to clear without an intent", () => {
    expect(
      shouldClearProviderRoutingIntent({
        saveStatus: "none",
        intendedMode: undefined,
        authoritativeMode: "fixed",
      }),
    ).toBe(false);
  });
});

describe("reconcileDraftModelSelectionAfterAutomaticRoute", () => {
  it("follows an automatic account switch when the draft still has the old thread selection", () => {
    const previousThreadSelection = { instanceId: codexOne, model: "gpt-5.6-sol" };
    const currentThreadSelection = { instanceId: codexTwo, model: "gpt-5.6-sol" };

    expect(
      reconcileDraftModelSelectionAfterAutomaticRoute({
        providerRoutingMode: "auto",
        previousThreadSelection,
        currentThreadSelection,
        draftSelection: previousThreadSelection,
      }),
    ).toEqual(currentThreadSelection);
  });

  it("preserves a model selection the user explicitly changed", () => {
    const previousThreadSelection = { instanceId: codexOne, model: "gpt-5.6-sol" };
    const explicitDraftSelection = { instanceId: codexOne, model: "gpt-5.4" };

    expect(
      reconcileDraftModelSelectionAfterAutomaticRoute({
        providerRoutingMode: "auto",
        previousThreadSelection,
        currentThreadSelection: { instanceId: codexTwo, model: "gpt-5.6-sol" },
        draftSelection: explicitDraftSelection,
      }),
    ).toBe(explicitDraftSelection);
  });

  it("preserves an explicit picker choice even when it matches the old thread selection", () => {
    const previousThreadSelection = { instanceId: codexOne, model: "gpt-5.6-sol" };

    expect(
      reconcileDraftModelSelectionAfterAutomaticRoute({
        providerRoutingMode: "auto",
        previousThreadSelection,
        currentThreadSelection: { instanceId: codexTwo, model: "gpt-5.6-sol" },
        draftSelection: previousThreadSelection,
        draftSelectionIsExplicit: true,
      }),
    ).toBe(previousThreadSelection);
  });
});

describe("eligibleProjectDefaultProviderRoutingMode", () => {
  it("falls back to fixed when the live account is not eligible for automatic routing", () => {
    expect(eligibleProjectDefaultProviderRoutingMode("auto", false)).toBe("fixed");
  });

  it("keeps Auto when the selected account belongs to an eligible pool", () => {
    expect(eligibleProjectDefaultProviderRoutingMode("auto", true)).toBe("auto");
  });

  it("keeps an explicit Fixed project default", () => {
    expect(eligibleProjectDefaultProviderRoutingMode("fixed", true)).toBe("fixed");
  });
});

describe("legacy pending task routing", () => {
  it("keeps a legacy edited task fixed even when the project now defaults to Auto", () => {
    expect(
      resolveNewTaskProviderRoutingMode({ editingMode: undefined, projectDefault: "auto" }),
    ).toBe("fixed");
  });

  it("preserves explicit routing mode and consent while editing a queued task", () => {
    expect(
      resolveNewTaskProviderRoutingMode({ editingMode: "auto", projectDefault: "fixed" }),
    ).toBe("auto");
    expect(
      providerAccountRoutingConsentForSubmission({
        editingConsent: true,
        providerRoutingMode: "auto",
        supported: true,
      }),
    ).toEqual({
      allowProviderAccountRouting: true,
    });
  });

  it("does not opt a legacy queued task into routing when it is edited", () => {
    expect(
      providerAccountRoutingConsentForSubmission({
        editingConsent: false,
        providerRoutingMode: "auto",
        supported: true,
      }),
    ).toEqual({});
  });

  it("adds routing consent only for a supported new Auto submission", () => {
    expect(
      providerAccountRoutingConsentForSubmission({
        editingConsent: null,
        providerRoutingMode: "auto",
        supported: true,
      }),
    ).toEqual({
      allowProviderAccountRouting: true,
    });
    expect(
      providerAccountRoutingConsentForSubmission({
        editingConsent: null,
        providerRoutingMode: "fixed",
        supported: true,
      }),
    ).toEqual({});
    expect(
      providerAccountRoutingConsentForSubmission({
        editingConsent: null,
        providerRoutingMode: "auto",
        supported: false,
      }),
    ).toEqual({});
  });
});

describe("providerRoutingAutoBlocker", () => {
  it("names the reason Auto is unavailable so the settings sheet can explain it", () => {
    const pair = [provider("codex-one"), provider("codex-two")];

    expect(providerRoutingAutoBlocker(pair, { codex: [codexOne, codexTwo] }, null, codexOne)).toBe(
      "threshold",
    );
    expect(
      providerRoutingAutoBlocker(
        [provider("codex-one", { availability: "unavailable" }), provider("codex-two")],
        { codex: [codexOne, codexTwo] },
        80,
        codexOne,
      ),
    ).toBe("account-unavailable");
    expect(providerRoutingAutoBlocker(pair, { codex: [codexTwo] }, 80, codexOne)).toBe(
      "account-not-pooled",
    );
    expect(providerRoutingAutoBlocker(pair, { codex: [codexOne] }, 80, codexOne)).toBe(
      "pool-too-small",
    );
    expect(
      providerRoutingAutoBlocker(pair, { codex: [codexOne, codexTwo] }, 80, codexOne),
    ).toBeNull();
  });

  it.each([
    ["deleted", null],
    ["unavailable", provider("codex-two", { availability: "unavailable" })],
    ["unready", provider("codex-two", { status: "error" })],
  ])("does not count a configured %s second account", (_case, secondProvider) => {
    const providers = [provider("codex-one"), ...(secondProvider ? [secondProvider] : [])];

    expect(
      providerRoutingAutoBlocker(providers, { codex: [codexOne, codexTwo] }, 80, codexOne),
    ).toBe("pool-too-small");
  });

  it("rejects a signed-out selected account", () => {
    expect(
      providerRoutingAutoBlocker(
        [provider("codex-one", { auth: { status: "unauthenticated" } }), provider("codex-two")],
        { codex: [codexOne, codexTwo] },
        80,
        codexOne,
      ),
    ).toBe("account-unavailable");
  });

  it.each([0, 101, 80.5])("rejects an invalid threshold: %s", (threshold) => {
    expect(
      providerRoutingAutoBlocker(
        [provider("codex-one"), provider("codex-two")],
        { codex: [codexOne, codexTwo] },
        threshold,
        codexOne,
      ),
    ).toBe("threshold");
  });
});
