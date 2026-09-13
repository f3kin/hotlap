import {
  CUSTOM_PROMPT_BODY_MAX_CHARS,
  CUSTOM_PROMPT_TITLE_MAX_CHARS,
  CUSTOM_PROMPTS_MAX_COUNT,
  type CustomPrompt,
} from "@t3tools/contracts/settings";
import {
  moveCustomPrompt,
  removeCustomPrompt,
  saveCustomPrompt,
} from "@t3tools/client-runtime/custom-prompts";
import { ArrowDownIcon, ArrowUpIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { randomUUID } from "~/lib/utils";
import { requestConfirmDialog } from "~/confirmDialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

type PromptDraft = CustomPrompt;

export function CustomPromptsSettings(props: {
  readonly prompts: readonly CustomPrompt[];
  readonly onChange: (prompts: readonly CustomPrompt[]) => void;
}) {
  const [draft, setDraft] = useState<PromptDraft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const closeEditor = () => {
    setDraft(null);
    setError(null);
  };
  const saveDraft = () => {
    if (!draft) return;
    const result = saveCustomPrompt(props.prompts, draft);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    props.onChange(result.prompts);
    closeEditor();
  };

  return (
    <>
      <div className="grid gap-2 p-3 sm:p-4">
        {props.prompts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Save prompts you use often. Choosing one fills the composer without sending it.
          </p>
        ) : (
          props.prompts.map((prompt, index) => (
            <div
              key={prompt.id}
              className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-background/40 p-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{prompt.title}</p>
                <p className="line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground">
                  {prompt.prompt}
                </p>
              </div>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                disabled={index === 0}
                aria-label={`Move ${prompt.title} up`}
                onClick={() => props.onChange(moveCustomPrompt(props.prompts, prompt.id, -1))}
              >
                <ArrowUpIcon />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                disabled={index === props.prompts.length - 1}
                aria-label={`Move ${prompt.title} down`}
                onClick={() => props.onChange(moveCustomPrompt(props.prompts, prompt.id, 1))}
              >
                <ArrowDownIcon />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Edit ${prompt.title}`}
                onClick={() => {
                  setError(null);
                  setDraft(prompt);
                }}
              >
                <PencilIcon />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Delete ${prompt.title}`}
                onClick={() => {
                  void requestConfirmDialog(`Delete custom prompt “${prompt.title}”?`, {
                    variant: "destructive",
                  })?.then((confirmed) => {
                    if (confirmed) {
                      props.onChange(removeCustomPrompt(props.prompts, prompt.id));
                    }
                  });
                }}
              >
                <Trash2Icon />
              </Button>
            </div>
          ))
        )}
        <Button
          size="sm"
          variant="outline"
          className="justify-self-start"
          disabled={props.prompts.length >= CUSTOM_PROMPTS_MAX_COUNT}
          onClick={() => {
            setError(null);
            setDraft({ id: randomUUID(), title: "", prompt: "" });
          }}
        >
          <PlusIcon />
          Add prompt
        </Button>
      </div>

      <Dialog open={draft !== null} onOpenChange={(open) => !open && closeEditor()}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {draft && props.prompts.some((prompt) => prompt.id === draft.id)
                ? "Edit custom prompt"
                : "Add custom prompt"}
            </DialogTitle>
            <DialogDescription>
              This prompt is stored on this environment and visible to its paired clients.
            </DialogDescription>
          </DialogHeader>
          {draft ? (
            <div className="grid gap-4 py-2">
              <label className="grid gap-1.5 text-sm text-foreground">
                Title
                <Input
                  autoFocus
                  maxLength={CUSTOM_PROMPT_TITLE_MAX_CHARS}
                  value={draft.title}
                  onChange={(event) => setDraft({ ...draft, title: event.currentTarget.value })}
                />
              </label>
              <label className="grid gap-1.5 text-sm text-foreground">
                Prompt
                <Textarea
                  maxLength={CUSTOM_PROMPT_BODY_MAX_CHARS}
                  value={draft.prompt}
                  onChange={(event) => setDraft({ ...draft, prompt: event.currentTarget.value })}
                />
              </label>
              {error ? (
                <p role="alert" className="text-sm text-destructive-foreground">
                  {error}
                </p>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={closeEditor}>
              Cancel
            </Button>
            <Button onClick={saveDraft}>Save</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
