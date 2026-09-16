import {
  EnvironmentId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";

vi.mock("../ui/dialog", () => ({
  Dialog: ({
    children,
    open,
    onOpenChange,
  }: {
    children: ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <div>
        {children}
        <button type="button" onClick={() => onOpenChange(false)}>
          Simulate Escape
        </button>
      </div>
    ) : null,
  DialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogPanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("./ProviderModelPicker", () => ({
  ProviderModelPicker: (props: {
    activeInstanceId: ProviderInstanceId;
    model: string;
    disabled?: boolean;
    triggerAriaLabel?: string;
    onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
  }) => (
    <>
      <button
        type="button"
        disabled={props.disabled}
        onClick={() =>
          props.onInstanceModelChange(ProviderInstanceId.make("claude_work"), "claude-opus-4-6")
        }
      >
        Choose Claude Opus
      </button>
      <button
        type="button"
        aria-label={props.triggerAriaLabel}
        disabled={props.disabled}
        onClick={() => props.onInstanceModelChange(props.activeInstanceId, props.model)}
      >
        Reselect current model
      </button>
    </>
  ),
}));

import { ForkConversationDialog, type ForkConversationSnapshot } from "./ForkConversationDialog";

const initialSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex_work"),
  model: "gpt-5.6-sol",
  options: [{ id: "reasoningEffort", value: "high" }],
};

const snapshot: ForkConversationSnapshot = {
  environmentId: EnvironmentId.make("environment-a"),
  sourceThreadId: ThreadId.make("thread-source"),
  sourceMessageId: MessageId.make("message-source"),
  modelSelection: initialSelection,
};

function provider(input?: {
  readonly instanceId?: string;
  readonly driver?: string;
  readonly model?: string;
  readonly status?: ServerProvider["status"];
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input?.instanceId ?? initialSelection.instanceId),
    driver: ProviderDriverKind.make(input?.driver ?? "codex"),
    enabled: true,
    installed: true,
    version: null,
    status: input?.status ?? "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-16T00:00:00.000Z",
    models: [
      {
        slug: input?.model ?? initialSelection.model,
        name: "Model",
        isCustom: false,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
  };
}

let renderer: ReactTestRenderer | null = null;

function renderDialog(input?: {
  readonly onCancel?: () => void;
  readonly onConfirm?: (snapshot: ForkConversationSnapshot) => Promise<void>;
  readonly providers?: ReadonlyArray<ServerProvider>;
}) {
  const providers = input?.providers ?? [
    provider(),
    provider({
      instanceId: "claude_work",
      driver: "claudeAgent",
      model: "claude-opus-4-6",
    }),
  ];
  act(() => {
    renderer = create(
      <ForkConversationDialog
        snapshot={snapshot}
        instanceEntries={deriveProviderInstanceEntries(providers)}
        modelOptionsByInstance={
          new Map([
            [initialSelection.instanceId, [{ slug: initialSelection.model, name: "GPT 5.6 Sol" }]],
            [
              ProviderInstanceId.make("claude_work"),
              [{ slug: "claude-opus-4-6", name: "Claude Opus 4.6" }],
            ],
          ])
        }
        onCancel={input?.onCancel ?? vi.fn()}
        onConfirm={input?.onConfirm ?? vi.fn().mockResolvedValue(undefined)}
      />,
    );
  });
}

function button(label: string) {
  return renderer!.root
    .findAllByType("button")
    .find((candidate) => candidate.children.includes(label))!;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("ForkConversationDialog", () => {
  it("announces the selected provider and model from the closed picker", () => {
    renderDialog();

    expect(
      renderer!.root.findByProps({ "aria-label": "Provider and model: Codex Work, GPT 5.6 Sol" }),
    ).toBeDefined();
  });

  it("allows an inherited Antigravity default alias", () => {
    const inherited = {
      ...snapshot,
      modelSelection: {
        instanceId: ProviderInstanceId.make("antigravity"),
        model: "antigravity-default",
      },
    };
    const antigravityProvider = {
      ...provider({ instanceId: "antigravity", driver: "antigravity", model: "gemini-3-pro" }),
      models: [
        {
          slug: "gemini-3-pro",
          name: "Gemini 3 Pro",
          aliases: ["antigravity-default"],
          isCustom: false,
          capabilities: null,
        },
      ],
    } satisfies ServerProvider;

    act(() => {
      renderer = create(
        <ForkConversationDialog
          snapshot={inherited}
          instanceEntries={deriveProviderInstanceEntries([antigravityProvider])}
          modelOptionsByInstance={
            new Map([
              [
                inherited.modelSelection.instanceId,
                [
                  {
                    slug: "gemini-3-pro",
                    name: "Gemini 3 Pro",
                    aliases: ["antigravity-default"],
                  },
                ],
              ],
            ])
          }
          onCancel={vi.fn()}
          onConfirm={vi.fn().mockResolvedValue(undefined)}
        />,
      );
    });

    expect(button("Fork conversation").props.disabled).toBe(false);
  });

  it("initializes the inherited selection when a closed dialog opens", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const providers = [provider()];
    const instanceEntries = deriveProviderInstanceEntries(providers);
    const modelOptionsByInstance = new Map([
      [initialSelection.instanceId, [{ slug: initialSelection.model, name: "GPT 5.6 Sol" }]],
    ]);
    act(() => {
      renderer = create(
        <ForkConversationDialog
          snapshot={null}
          instanceEntries={instanceEntries}
          modelOptionsByInstance={modelOptionsByInstance}
          onCancel={vi.fn()}
          onConfirm={onConfirm}
        />,
      );
    });

    act(() => {
      renderer!.update(
        <ForkConversationDialog
          snapshot={snapshot}
          instanceEntries={instanceEntries}
          modelOptionsByInstance={modelOptionsByInstance}
          onCancel={vi.fn()}
          onConfirm={onConfirm}
        />,
      );
    });
    await act(async () => button("Fork conversation").props.onClick());

    expect(onConfirm).toHaveBeenCalledWith(snapshot);
  });

  it("cancels without creating a fork", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    renderDialog({ onCancel, onConfirm });

    act(() => button("Cancel").props.onClick());

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("confirms the snapshotted source and full inherited model selection exactly once", async () => {
    let resolveConfirm!: () => void;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConfirm = resolve;
        }),
    );
    renderDialog({ onConfirm });

    await act(async () => {
      button("Fork conversation").props.onClick();
      button("Fork conversation").props.onClick();
    });

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onConfirm).toHaveBeenCalledWith(snapshot);
    expect(button("Choose Claude Opus").props.disabled).toBe(true);

    await act(async () => resolveConfirm());
  });

  it("preserves inherited options when the same model is reselected", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    renderDialog({ onConfirm });

    act(() => button("Reselect current model").props.onClick());
    await act(async () => button("Fork conversation").props.onClick());

    expect(onConfirm).toHaveBeenCalledWith(snapshot);
  });

  it("changes only the dialog selection before confirming the same source", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    renderDialog({ onConfirm });

    act(() => button("Choose Claude Opus").props.onClick());
    await act(async () => button("Fork conversation").props.onClick());

    expect(onConfirm).toHaveBeenCalledWith({
      ...snapshot,
      modelSelection: {
        instanceId: ProviderInstanceId.make("claude_work"),
        model: "claude-opus-4-6",
      },
    });
  });

  it("keeps the dialog choice through ordinary parent rerenders", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const providers = [
      provider(),
      provider({
        instanceId: "claude_work",
        driver: "claudeAgent",
        model: "claude-opus-4-6",
      }),
    ];
    const instanceEntries = deriveProviderInstanceEntries(providers);
    const modelOptionsByInstance = new Map([
      [initialSelection.instanceId, [{ slug: initialSelection.model, name: "GPT 5.6 Sol" }]],
      [
        ProviderInstanceId.make("claude_work"),
        [{ slug: "claude-opus-4-6", name: "Claude Opus 4.6" }],
      ],
    ]);
    renderDialog({ onConfirm, providers });
    act(() => button("Choose Claude Opus").props.onClick());

    act(() => {
      renderer!.update(
        <ForkConversationDialog
          snapshot={snapshot}
          instanceEntries={instanceEntries}
          modelOptionsByInstance={modelOptionsByInstance}
          onCancel={vi.fn()}
          onConfirm={onConfirm}
        />,
      );
    });
    await act(async () => button("Fork conversation").props.onClick());

    expect(onConfirm).toHaveBeenCalledWith({
      ...snapshot,
      modelSelection: {
        instanceId: ProviderInstanceId.make("claude_work"),
        model: "claude-opus-4-6",
      },
    });
  });

  it("keeps an unavailable inherited choice visible but blocks confirmation", () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    renderDialog({ onConfirm, providers: [provider({ status: "error" })] });

    expect(button("Choose Claude Opus")).toBeDefined();
    expect(button("Fork conversation").props.disabled).toBe(true);
    expect(renderer!.root.findAllByProps({ role: "alert" })[0]?.children.join("")).toContain(
      "unavailable",
    );

    act(() => button("Fork conversation").props.onClick());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("closes on Escape without creating a fork", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    renderDialog({ onCancel, onConfirm });

    act(() => button("Simulate Escape").props.onClick());

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("stays open and shows a clear error when creation fails", async () => {
    const onCancel = vi.fn();
    renderDialog({
      onCancel,
      onConfirm: vi.fn().mockRejectedValue(new Error("Source conversation became busy.")),
    });

    await act(async () => button("Fork conversation").props.onClick());

    expect(onCancel).not.toHaveBeenCalled();
    expect(renderer!.root.findAllByProps({ role: "alert" })[0]?.children.join("")).toContain(
      "Source conversation became busy.",
    );
    expect(button("Fork conversation")).toBeDefined();
  });
});
