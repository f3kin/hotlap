import type { CustomPrompt } from "@t3tools/contracts/settings";
import { Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";

export function CustomPromptSheet(props: {
  readonly visible: boolean;
  readonly prompts: readonly CustomPrompt[];
  readonly onClose: () => void;
  readonly onSelect: (prompt: CustomPrompt) => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle={Platform.OS === "android" ? "overFullScreen" : "pageSheet"}
      onRequestClose={props.onClose}
    >
      <View className="flex-1 bg-sheet" style={{ paddingTop: Math.max(insets.top, 12) }}>
        <View className="min-h-14 flex-row items-center border-b border-border-subtle px-4">
          <Text className="flex-1 text-xl font-t3-bold text-foreground">Custom prompts</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close custom prompts"
            className="size-11 items-center justify-center rounded-full active:bg-subtle"
            onPress={props.onClose}
          >
            <SymbolView
              name="xmark"
              size={18}
              tintColorClassName="accent-icon"
              type="monochrome"
              weight="semibold"
            />
          </Pressable>
        </View>
        <ScrollView
          contentContainerClassName="gap-2 p-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) }}
        >
          {props.prompts.map((prompt) => (
            <Pressable
              key={prompt.id}
              accessibilityRole="button"
              accessibilityLabel={`Use custom prompt: ${prompt.title}`}
              accessibilityHint="Fills the composer without sending"
              className="min-h-11 rounded-2xl bg-card p-4 active:opacity-70"
              onPress={() => props.onSelect(prompt)}
            >
              <Text className="text-base font-t3-bold text-foreground">{prompt.title}</Text>
              <Text className="mt-1 text-sm text-foreground-muted" numberOfLines={3}>
                {prompt.prompt}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}
