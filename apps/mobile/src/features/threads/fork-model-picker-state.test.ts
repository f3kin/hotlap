import { describe, expect, it } from "vite-plus/test";

import {
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type ServerConfig,
} from "@t3tools/contracts";

import {
  buildForkCommandInput,
  buildForkModelOptions,
  canConfirmForkModelSelection,
  forkModelPickerShouldClose,
  openForkModelPicker,
} from "./fork-model-picker-state";

describe("mobile fork model picker", () => {
  it("snapshots the source and complete inherited model selection", () => {
    const state = openForkModelPicker({
      environmentId: EnvironmentId.make("remote"),
      sourceThreadId: ThreadId.make("source"),
      sourceMessageId: MessageId.make("answer"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex-work"),
        model: "gpt-5.6-sol",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "serviceTier", value: "priority" },
        ],
      },
    });

    expect(state).toMatchObject({
      source: {
        environmentId: "remote",
        threadId: "source",
        messageId: "answer",
      },
      selectedModel: {
        instanceId: "codex-work",
        model: "gpt-5.6-sol",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "serviceTier", value: "priority" },
        ],
      },
      status: "idle",
      error: null,
    });
  });

  it("offers only enabled and runnable provider catalogs", () => {
    const provider = (input: {
      instanceId: string;
      enabled?: boolean;
      status?: "ready" | "error";
    }) => ({
      instanceId: input.instanceId,
      driver: input.instanceId.startsWith("claude") ? "claudeAgent" : "codex",
      displayName: input.instanceId,
      enabled: input.enabled ?? true,
      installed: true,
      status: input.status ?? "ready",
      auth: { status: "authenticated" },
      models: [
        {
          slug: `${input.instanceId}-model`,
          name: `${input.instanceId} model`,
          isCustom: false,
          capabilities: null,
        },
      ],
    });
    const config = {
      providers: [
        provider({ instanceId: "codex-work" }),
        provider({ instanceId: "claude-disabled", enabled: false }),
        provider({ instanceId: "codex-error", status: "error" }),
      ],
    } as unknown as ServerConfig;

    expect(
      buildForkModelOptions(config, {
        instanceId: ProviderInstanceId.make("codex-work"),
        model: "codex-work-model",
      }).map((option) => option.key),
    ).toEqual(["codex-work:codex-work-model"]);
  });

  it("keeps an inherited Antigravity default alias runnable", () => {
    const inherited = {
      instanceId: ProviderInstanceId.make("antigravity"),
      model: "antigravity-default",
    };
    const config = {
      providers: [
        {
          instanceId: inherited.instanceId,
          driver: "antigravity",
          displayName: "Antigravity",
          enabled: true,
          installed: true,
          status: "ready",
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gemini-3-pro",
              name: "Gemini 3 Pro",
              aliases: [inherited.model],
              isDefault: true,
              isCustom: false,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const options = buildForkModelOptions(config, inherited);

    expect(options).toContainEqual(
      expect.objectContaining({
        key: "antigravity:antigravity-default",
        label: "Gemini 3 Pro",
        selection: inherited,
      }),
    );
    expect(canConfirmForkModelSelection(inherited, options)).toBe(true);
  });

  it("shows an unavailable inherited choice without allowing confirmation", () => {
    const inherited = {
      instanceId: ProviderInstanceId.make("claude-old"),
      model: "claude-opus-old",
      options: [{ id: "effort", value: "high" }],
    };
    const config = {
      providers: [
        {
          instanceId: inherited.instanceId,
          driver: "claudeAgent",
          displayName: "Work account",
          enabled: false,
          installed: true,
          status: "disabled",
          auth: { status: "authenticated" },
          models: [
            {
              slug: inherited.model,
              name: "Claude Opus Old",
              isCustom: false,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const options = buildForkModelOptions(config, inherited);

    expect(options).toMatchObject([
      {
        key: "claude-old:claude-opus-old",
        label: "Claude Opus Old",
        providerLabel: "Work account",
        isUnavailable: true,
        selection: inherited,
      },
    ]);
    expect(canConfirmForkModelSelection(inherited, options)).toBe(false);
  });

  it("does not confirm an inherited model that left a healthy provider catalog", () => {
    const inherited = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "removed-model",
    };
    const config = {
      providers: [
        {
          instanceId: inherited.instanceId,
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          status: "ready",
          auth: { status: "authenticated" },
          models: [
            {
              slug: "current-model",
              name: "Current model",
              isCustom: false,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const removed = buildForkModelOptions(config, inherited).find(
      (option) => option.selection.model === inherited.model,
    );

    expect(removed?.isUnavailable).toBe(true);
    expect(canConfirmForkModelSelection(inherited, removed ? [removed] : [])).toBe(false);
  });

  it.each([
    ["disconnects", { connected: false }],
    ["changes environment", { environmentId: EnvironmentId.make("other") }],
    ["changes thread", { threadId: ThreadId.make("other") }],
    ["loses the selected response", { sourceMessageAvailable: false }],
  ])("closes when the source %s", (_label, override) => {
    const state = openForkModelPicker({
      environmentId: EnvironmentId.make("remote"),
      sourceThreadId: ThreadId.make("source"),
      sourceMessageId: MessageId.make("answer"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
      },
    });

    expect(
      forkModelPickerShouldClose(state, {
        connected: true,
        environmentId: EnvironmentId.make("remote"),
        threadId: ThreadId.make("source"),
        sourceMessageAvailable: true,
        ...override,
      }),
    ).toBe(true);
  });

  it("keeps a submitting picker open while its connected source is unchanged", () => {
    const state = {
      ...openForkModelPicker({
        environmentId: EnvironmentId.make("remote"),
        sourceThreadId: ThreadId.make("source"),
        sourceMessageId: MessageId.make("answer"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-sol",
        },
      }),
      status: "submitting" as const,
    };

    expect(
      forkModelPickerShouldClose(state, {
        connected: true,
        environmentId: EnvironmentId.make("remote"),
        threadId: ThreadId.make("source"),
        sourceMessageAvailable: true,
      }),
    ).toBe(false);
  });

  it("builds confirmation input only from the saved picker snapshot", () => {
    const state = openForkModelPicker({
      environmentId: EnvironmentId.make("remote"),
      sourceThreadId: ThreadId.make("source"),
      sourceMessageId: MessageId.make("answer"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("claude-work"),
        model: "claude-opus-5-1",
        options: [{ id: "effort", value: "high" }],
      },
    });

    expect(
      buildForkCommandInput(state, ThreadId.make("destination"), "2026-09-16T10:00:00.000Z"),
    ).toEqual({
      threadId: "destination",
      sourceThreadId: "source",
      sourceMessageId: "answer",
      modelSelection: {
        instanceId: "claude-work",
        model: "claude-opus-5-1",
        options: [{ id: "effort", value: "high" }],
      },
      createdAt: "2026-09-16T10:00:00.000Z",
    });
  });
});
