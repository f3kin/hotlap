import type { ProviderRoutingMode } from "@t3tools/contracts";

import { Select, SelectItem, SelectPopup, SelectValue } from "../ui/select";
import { ComposerSelectControl, type ComposerControlSize } from "./ComposerControl";
import { composerFloatingLayerProps } from "./composerEventScope";

export function ProviderRoutingModeControl(props: {
  readonly mode: ProviderRoutingMode;
  readonly accountLabel: string;
  /** Signed-in email for the current account, when the provider reports one. */
  readonly accountEmail?: string | undefined;
  readonly size: ComposerControlSize;
  readonly disabled?: boolean;
  /** Why Auto cannot be chosen, or null when it can. */
  readonly autoDisabledReason: string | null;
  readonly onChange: (mode: ProviderRoutingMode) => void;
}) {
  return (
    <Select
      value={props.mode}
      disabled={props.disabled}
      onValueChange={(value) => {
        if (value === "auto" || value === "fixed") props.onChange(value);
      }}
    >
      <ComposerSelectControl
        size={props.size}
        aria-label={`Account switching: ${props.mode}. Current account: ${props.accountLabel}${props.accountEmail ? ` (${props.accountEmail})` : ""}`}
        className="max-w-56"
      >
        <SelectValue>
          <span className="truncate">
            {props.mode === "auto" ? "Auto" : "Fixed"} · {props.accountLabel}
          </span>
        </SelectValue>
      </ComposerSelectControl>
      <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
        <SelectItem value="auto" className="min-w-60" disabled={props.autoDisabledReason !== null}>
          <div className="grid gap-0.5 py-1">
            <span className="font-medium">Auto</span>
            <span className="text-xs text-muted-foreground">
              {props.autoDisabledReason ?? "Use the next available project account when needed."}
            </span>
          </div>
        </SelectItem>
        <SelectItem value="fixed" className="min-w-60">
          <div className="grid gap-0.5 py-1">
            <span className="font-medium">Fixed</span>
            <span className="text-xs text-muted-foreground">
              {props.accountEmail ? `Stay on ${props.accountEmail}.` : "Stay on this account."}
            </span>
          </div>
        </SelectItem>
      </SelectPopup>
    </Select>
  );
}
