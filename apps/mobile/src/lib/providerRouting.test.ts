import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canEnableProviderRoutingAuto,
  eligibleProjectDefaultProviderRoutingMode,
  providerAccountRoutingConsentForSubmission,
  reconcileDraftModelSelectionAfterAutomaticRoute,
  resolveProviderRoutingModeForSubmission,
  resolveNewTaskProviderRoutingMode,
  routingModeAfterManualModelSelection,
  shouldClearAcknowledgedProviderRoutingIntent,
} from "./providerRouting";

const codexOne = ProviderInstanceId.make("codex-one");
const codexTwo = ProviderInstanceId.make("codex-two");

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
});

describe("shouldClearAcknowledgedProviderRoutingIntent", () => {
  it("clears the latest saved Fixed intent when Auto was coalesced before projection", () => {
    expect(
      shouldClearAcknowledgedProviderRoutingIntent({
        acknowledged: true,
        intendedMode: "fixed",
        authoritativeMode: "fixed",
      }),
    ).toBe(true);
  });

  it("keeps an intent until its save is acknowledged and projected", () => {
    expect(
      shouldClearAcknowledgedProviderRoutingIntent({
        acknowledged: false,
        intendedMode: "fixed",
        authoritativeMode: "fixed",
      }),
    ).toBe(false);
    expect(
      shouldClearAcknowledgedProviderRoutingIntent({
        acknowledged: true,
        intendedMode: "fixed",
        authoritativeMode: "auto",
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

describe("canEnableProviderRoutingAuto", () => {
  it("allows two runnable configured accounts for the selected provider", () => {
    expect(
      canEnableProviderRoutingAuto(
        [provider("codex-one"), provider("codex-two")],
        { codex: [codexOne, codexTwo] },
        80,
        codexOne,
      ),
    ).toBe(true);
  });

  it.each([
    ["deleted", null],
    ["unavailable", provider("codex-two", { availability: "unavailable" })],
    ["unready", provider("codex-two", { status: "error" })],
  ])("rejects a configured %s second account", (_case, secondProvider) => {
    const providers = [provider("codex-one"), ...(secondProvider ? [secondProvider] : [])];

    expect(
      canEnableProviderRoutingAuto(providers, { codex: [codexOne, codexTwo] }, 80, codexOne),
    ).toBe(false);
  });

  it("rejects an unready selected account", () => {
    expect(
      canEnableProviderRoutingAuto(
        [provider("codex-one", { auth: { status: "unauthenticated" } }), provider("codex-two")],
        { codex: [codexOne, codexTwo] },
        80,
        codexOne,
      ),
    ).toBe(false);
  });

  it.each([null, 0, 101, 80.5])("rejects an unset or invalid threshold: %s", (threshold) => {
    expect(
      canEnableProviderRoutingAuto(
        [provider("codex-one"), provider("codex-two")],
        { codex: [codexOne, codexTwo] },
        threshold,
        codexOne,
      ),
    ).toBe(false);
  });
});
