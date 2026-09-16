import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canEnableProviderRoutingAuto,
  deriveProviderRoutingOptions,
  mergeProviderRoutingOptions,
  resolveProviderRoutingDefaultMode,
  supportsProviderAccountRouting,
  toggleProviderRoutingInstance,
} from "./ProviderRoutingSettings.logic";

function provider(
  instanceId: string,
  driver: string,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
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

describe("deriveProviderRoutingOptions", () => {
  it("offers only runnable Codex and Claude instances available on every selected environment", () => {
    const first = [
      provider("codex_work", "codex", { displayName: "Work" }),
      provider("claude_work", "claudeAgent"),
      provider("cursor_work", "cursor"),
      provider("codex_signed_out", "codex", { auth: { status: "unauthenticated" } }),
    ];
    const second = [provider("codex_work", "codex"), provider("cursor_work", "cursor")];

    expect(deriveProviderRoutingOptions([first, second])).toEqual([
      {
        instanceId: ProviderInstanceId.make("codex_work"),
        driver: ProviderDriverKind.make("codex"),
        displayName: "Work",
      },
    ]);
  });
});

describe("supportsProviderAccountRouting", () => {
  it("requires an explicit capability so older servers never receive new writes", () => {
    expect(supportsProviderAccountRouting({ providerAccountRouting: true })).toBe(true);
    expect(supportsProviderAccountRouting({})).toBe(false);
    expect(supportsProviderAccountRouting(null)).toBe(false);
  });
});

describe("provider routing pool", () => {
  const first = ProviderInstanceId.make("codex_work");
  const second = ProviderInstanceId.make("codex_personal");

  it("deduplicates enabled instances and removes every copy of a disabled instance", () => {
    expect(toggleProviderRoutingInstance([first, first], second, true)).toEqual([first, second]);
    expect(toggleProviderRoutingInstance([first, second, first], first, false)).toEqual([second]);
    expect(toggleProviderRoutingInstance([first, second], first, false)).toEqual([second]);
  });

  it("keeps unavailable saved accounts removable without treating pool order as priority", () => {
    const options = [
      { instanceId: first, driver: ProviderDriverKind.make("codex"), displayName: "Work" },
      { instanceId: second, driver: ProviderDriverKind.make("codex"), displayName: "Personal" },
    ];
    const missing = ProviderInstanceId.make("codex_old");

    expect(
      mergeProviderRoutingOptions(ProviderDriverKind.make("codex"), options, [
        second,
        missing,
        first,
      ]),
    ).toEqual([
      options[0],
      options[1],
      {
        instanceId: missing,
        driver: ProviderDriverKind.make("codex"),
        displayName: "codex_old",
        unavailable: true,
      },
    ]);
  });

  it("allows auto only with two runnable accounts for one provider", () => {
    const codex = ProviderDriverKind.make("codex");
    const claude = ProviderDriverKind.make("claudeAgent");
    const options = [
      { instanceId: first, driver: codex, displayName: "Work" },
      { instanceId: second, driver: codex, displayName: "Personal" },
      {
        instanceId: ProviderInstanceId.make("claude_work"),
        driver: claude,
        displayName: "Claude",
      },
    ];

    expect(
      canEnableProviderRoutingAuto(options, { [codex]: [first, second] }, 80, {
        instanceId: first,
      }),
    ).toBe(true);
    expect(
      canEnableProviderRoutingAuto(
        options,
        {
          [codex]: [first],
          [claude]: [ProviderInstanceId.make("claude_work")],
        },
        80,
        { instanceId: first },
      ),
    ).toBe(false);
  });

  it("requires the project's selected account to belong to the eligible pool", () => {
    const codex = ProviderDriverKind.make("codex");
    const options = [
      { instanceId: first, driver: codex, displayName: "Work" },
      { instanceId: second, driver: codex, displayName: "Personal" },
    ];

    expect(
      canEnableProviderRoutingAuto(options, { [codex]: [first, second] }, 80, {
        instanceId: ProviderInstanceId.make("codex_other"),
      }),
    ).toBe(false);
  });

  it("requires the user to choose a threshold before enabling auto", () => {
    const codex = ProviderDriverKind.make("codex");
    const options = [
      { instanceId: first, driver: codex, displayName: "Work" },
      { instanceId: second, driver: codex, displayName: "Personal" },
    ];

    expect(
      canEnableProviderRoutingAuto(options, { [codex]: [first, second] }, null, {
        instanceId: first,
      }),
    ).toBe(false);
  });

  it("does not count duplicate saved ids as separate accounts", () => {
    const codex = ProviderDriverKind.make("codex");
    const options = [{ instanceId: first, driver: codex, displayName: "Work" }];

    expect(
      canEnableProviderRoutingAuto(options, { [codex]: [first, first] }, 80, { instanceId: first }),
    ).toBe(false);
  });

  it("turns an invalid automatic default back to fixed when the selected account changes", () => {
    const codex = ProviderDriverKind.make("codex");
    const options = [
      { instanceId: first, driver: codex, displayName: "Work" },
      { instanceId: second, driver: codex, displayName: "Personal" },
    ];

    expect(
      resolveProviderRoutingDefaultMode("auto", options, { [codex]: [first, second] }, 80, {
        instanceId: ProviderInstanceId.make("codex_other"),
      }),
    ).toBe("fixed");
    expect(
      resolveProviderRoutingDefaultMode("auto", options, { [codex]: [first, second] }, 80, {
        instanceId: first,
      }),
    ).toBe("auto");
  });
});
