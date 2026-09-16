import type {
  EnvironmentId,
  MessageId,
  ModelSelection,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { useRef, useState } from "react";

import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { resolveModelPickerSelectedModel } from "./ModelPickerContent";
import { ProviderModelPicker } from "./ProviderModelPicker";
import type { ModelEsque } from "./providerIconUtils";

export type ForkConversationSnapshot = {
  readonly environmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
  readonly sourceMessageId: MessageId;
  readonly modelSelection: ModelSelection;
};

export function ForkConversationDialog(props: {
  readonly snapshot: ForkConversationSnapshot | null;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly onCancel: () => void;
  readonly onConfirm: (snapshot: ForkConversationSnapshot) => Promise<void>;
}) {
  if (props.snapshot === null) return null;

  return (
    <OpenForkConversationDialog
      key={`${props.snapshot.environmentId}:${props.snapshot.sourceThreadId}:${props.snapshot.sourceMessageId}`}
      snapshot={props.snapshot}
      instanceEntries={props.instanceEntries}
      modelOptionsByInstance={props.modelOptionsByInstance}
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
    />
  );
}

function OpenForkConversationDialog(props: {
  readonly snapshot: ForkConversationSnapshot;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly onCancel: () => void;
  readonly onConfirm: (snapshot: ForkConversationSnapshot) => Promise<void>;
}) {
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(
    props.snapshot.modelSelection,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const selectedEntry = modelSelection
    ? props.instanceEntries.find((entry) => entry.instanceId === modelSelection.instanceId)
    : undefined;
  const selectedModel = modelSelection
    ? resolveModelPickerSelectedModel({
        driverKind: selectedEntry?.driverKind,
        model: modelSelection.model,
        options: props.modelOptionsByInstance.get(modelSelection.instanceId) ?? [],
      })
    : undefined;
  const selectionUnavailable =
    selectedEntry === undefined ||
    !isProviderInstancePickerReady(selectedEntry) ||
    selectedModel === undefined ||
    selectedModel.isUnavailable === true;
  const pickerAriaLabel = modelSelection
    ? `Provider and model: ${selectedEntry?.displayName ?? modelSelection.instanceId}, ${selectedModel?.name ?? modelSelection.model}`
    : "Provider and model";

  const confirm = async () => {
    if (modelSelection === null || selectionUnavailable || pendingRef.current) {
      return;
    }
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await props.onConfirm({ ...props.snapshot, modelSelection });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not fork conversation.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) props.onCancel();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Fork conversation</DialogTitle>
          <DialogDescription>Choose how the new conversation should continue.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {modelSelection ? (
            <ProviderModelPicker
              activeInstanceId={modelSelection.instanceId}
              model={modelSelection.model}
              lockedProvider={null}
              instanceEntries={props.instanceEntries}
              modelOptionsByInstance={props.modelOptionsByInstance}
              disabled={pending}
              triggerVariant="outline"
              triggerAriaLabel={pickerAriaLabel}
              onInstanceModelChange={(instanceId, model) => {
                setModelSelection((current) =>
                  current?.instanceId === instanceId && current.model === model
                    ? current
                    : { instanceId, model },
                );
              }}
            />
          ) : null}
          {selectionUnavailable && modelSelection ? (
            <p role="alert" className="mt-3 text-sm text-muted-foreground">
              The selected provider or model is unavailable. Choose an available option to fork.
            </p>
          ) : null}
          <p className="mt-3 text-sm text-muted-foreground">
            Recent history through the selected response is included. Older history stays in the
            source thread. Files stay in the current workspace.
          </p>
          {error ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={props.onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={pending || modelSelection === null || selectionUnavailable}
            onClick={() => void confirm()}
          >
            {pending ? "Forking…" : "Fork conversation"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
