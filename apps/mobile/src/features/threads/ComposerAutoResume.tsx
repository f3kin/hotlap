import type { UsageLimitAutoResumePayload } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";

/** Resets can be up to 12 hours out, so a reset past midnight says so. */
function formatResetTime(reset: Date): string {
  const time = reset.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return reset.toDateString() === new Date().toDateString() ? time : `tomorrow at ${time}`;
}

/** Shown above the composer while the server waits out a usage limit for this thread. */
export function ComposerAutoResume({
  wait,
  onCancel,
}: {
  readonly wait: UsageLimitAutoResumePayload;
  readonly onCancel: () => Promise<unknown>;
}) {
  const [cancelling, setCancelling] = useState(false);
  const description = wait.resetAt
    ? `Auto-resumes after ${formatResetTime(new Date(wait.resetAt))}`
    : "Retrying every 5 minutes";
  return (
    <View className="px-4 pb-3">
      <View className="flex-row items-center gap-3 rounded-[20px] border-continuous bg-card p-4">
        <SymbolView name="timer" size={16} tintColorClassName="accent-icon-muted" />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text accessibilityLiveRegion="polite" className="text-sm text-foreground">
            Waiting for the usage limit to reset
          </Text>
          <Text className="text-xs text-foreground-muted">{description}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          disabled={cancelling}
          hitSlop={8}
          onPress={() => {
            setCancelling(true);
            void onCancel().finally(() => setCancelling(false));
          }}
          className="py-1 active:opacity-60"
        >
          <Text className="text-sm text-foreground">{cancelling ? "Cancelling..." : "Cancel"}</Text>
        </Pressable>
      </View>
    </View>
  );
}
