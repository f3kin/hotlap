import { useAtomValue } from "@effect/atom-react";
import {
  moveCustomPrompt,
  removeCustomPrompt,
  saveCustomPrompt,
} from "@t3tools/client-runtime/custom-prompts";
import {
  CUSTOM_PROMPT_BODY_MAX_CHARS,
  CUSTOM_PROMPT_TITLE_MAX_CHARS,
  CUSTOM_PROMPTS_MAX_COUNT,
  type CustomPrompt,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useMemo, useState } from "react";
import { Alert, Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { uuidv4 } from "../../lib/uuid";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

function IconAction(props: {
  readonly label: string;
  readonly icon: "chevron.up" | "chevron.down" | "square.and.pencil" | "trash";
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled }}
      className="size-11 items-center justify-center rounded-full active:bg-subtle"
      disabled={props.disabled}
      onPress={props.onPress}
      style={{ opacity: props.disabled ? 0.35 : 1 }}
    >
      <SymbolView
        name={props.icon}
        size={18}
        tintColorClassName={props.icon === "trash" ? "accent-danger" : "accent-icon"}
        type="monochrome"
      />
    </Pressable>
  );
}

export function SettingsCustomPromptsRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const capableEnvironments = useMemo(
    () =>
      environments.filter(
        (environment) => environment.serverConfig?.environment.capabilities.customPrompts === true,
      ),
    [environments],
  );
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    capableEnvironments[0]?.environmentId ?? null,
  );
  const selectedEnvironment =
    capableEnvironments.find(
      (environment) => environment.environmentId === selectedEnvironmentId,
    ) ??
    capableEnvironments[0] ??
    null;
  const settings = useAtomValue(
    serverEnvironment.settingsValueAtom(
      selectedEnvironment?.environmentId ?? ("unavailable" as EnvironmentId),
    ),
  );
  const prompts = settings?.customPrompts ?? [];
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "custom prompts update",
    reportFailure: true,
  });
  const [draft, setDraft] = useState<CustomPrompt | null>(null);
  const writesDisabled = selectedEnvironment?.connection.phase !== "connected";

  const writePrompts = useCallback(
    (customPrompts: readonly CustomPrompt[]) => {
      if (!selectedEnvironment || writesDisabled) return;
      void updateSettings({
        environmentId: selectedEnvironment.environmentId,
        input: { patch: { customPrompts } },
      });
    },
    [selectedEnvironment, updateSettings, writesDisabled],
  );

  const saveDraft = () => {
    if (!draft) return;
    const result = saveCustomPrompt(prompts, draft);
    if (!result.ok) {
      Alert.alert("Cannot save prompt", result.message);
      return;
    }
    writePrompts(result.prompts);
    setDraft(null);
  };
  const confirmRemovePrompt = (prompt: CustomPrompt) => {
    Alert.alert(
      "Delete custom prompt?",
      `“${prompt.title}” will be removed from this environment.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => writePrompts(removeCustomPrompt(prompts, prompt.id)),
        },
      ],
    );
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Custom Prompts" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {capableEnvironments.length > 1 ? (
          <SettingsSection title="Environment">
            {capableEnvironments.map((environment) => {
              const selected = environment.environmentId === selectedEnvironment?.environmentId;
              return (
                <Pressable
                  key={environment.environmentId}
                  accessibilityRole="radio"
                  accessibilityLabel={environment.label}
                  accessibilityState={{ checked: selected }}
                  className="min-h-11 flex-row items-center gap-3 border-b border-border-subtle p-4 last:border-b-0 active:opacity-70"
                  onPress={() => setSelectedEnvironmentId(environment.environmentId)}
                >
                  <Text className="flex-1 text-lg text-foreground">{environment.label}</Text>
                  {selected ? (
                    <SymbolView
                      name="checkmark"
                      size={18}
                      tintColorClassName="accent-icon"
                      type="monochrome"
                    />
                  ) : null}
                </Pressable>
              );
            })}
          </SettingsSection>
        ) : null}

        <SettingsSection title={selectedEnvironment?.label ?? "Custom prompts"}>
          {selectedEnvironment === null ? (
            <Text className="p-4 text-base text-foreground-muted">
              Connect to an updated environment to manage custom prompts.
            </Text>
          ) : prompts.length === 0 ? (
            <Text className="p-4 text-base text-foreground-muted">
              Save prompts you use often. Choosing one fills the composer without sending it.
            </Text>
          ) : (
            prompts.map((prompt, index) => (
              <View key={prompt.id} className="border-b border-border-subtle p-4 last:border-b-0">
                <Text className="text-base font-t3-bold text-foreground">{prompt.title}</Text>
                <Text className="mt-1 text-sm text-foreground-muted" numberOfLines={3}>
                  {prompt.prompt}
                </Text>
                <View className="mt-2 flex-row justify-end">
                  <IconAction
                    label={`Move ${prompt.title} up`}
                    icon="chevron.up"
                    disabled={writesDisabled || index === 0}
                    onPress={() => writePrompts(moveCustomPrompt(prompts, prompt.id, -1))}
                  />
                  <IconAction
                    label={`Move ${prompt.title} down`}
                    icon="chevron.down"
                    disabled={writesDisabled || index === prompts.length - 1}
                    onPress={() => writePrompts(moveCustomPrompt(prompts, prompt.id, 1))}
                  />
                  <IconAction
                    label={`Edit ${prompt.title}`}
                    icon="square.and.pencil"
                    disabled={writesDisabled}
                    onPress={() => setDraft(prompt)}
                  />
                  <IconAction
                    label={`Delete ${prompt.title}`}
                    icon="trash"
                    disabled={writesDisabled}
                    onPress={() => confirmRemovePrompt(prompt)}
                  />
                </View>
              </View>
            ))
          )}
          {selectedEnvironment ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add custom prompt"
              accessibilityState={{
                disabled: writesDisabled || prompts.length >= CUSTOM_PROMPTS_MAX_COUNT,
              }}
              disabled={writesDisabled || prompts.length >= CUSTOM_PROMPTS_MAX_COUNT}
              className="min-h-11 flex-row items-center justify-center gap-2 p-4 active:opacity-70"
              style={{
                opacity: writesDisabled || prompts.length >= CUSTOM_PROMPTS_MAX_COUNT ? 0.45 : 1,
              }}
              onPress={() => setDraft({ id: uuidv4(), title: "", prompt: "" })}
            >
              <SymbolView
                name="plus"
                size={18}
                tintColorClassName="accent-icon"
                type="monochrome"
              />
              <Text className="text-base font-t3-bold text-foreground">Add prompt</Text>
            </Pressable>
          ) : null}
        </SettingsSection>
        {writesDisabled && selectedEnvironment ? (
          <Text className="px-2 text-sm text-foreground-muted">
            Reconnect to this environment to change its prompts.
          </Text>
        ) : null}
      </ScrollView>

      <Modal
        visible={draft !== null}
        animationType="slide"
        presentationStyle={Platform.OS === "android" ? "overFullScreen" : "pageSheet"}
        onRequestClose={() => setDraft(null)}
      >
        {draft ? (
          <View
            className="flex-1 gap-4 bg-sheet px-5"
            style={{ paddingTop: Math.max(insets.top, 20) }}
          >
            <Text className="text-2xl font-t3-bold text-foreground">
              {prompts.some((prompt) => prompt.id === draft.id) ? "Edit prompt" : "Add prompt"}
            </Text>
            <TextInput
              autoFocus
              accessibilityLabel="Prompt title"
              className="min-h-11 rounded-2xl bg-card px-4 text-base text-foreground"
              maxLength={CUSTOM_PROMPT_TITLE_MAX_CHARS}
              placeholder="Title"
              value={draft.title}
              onChangeText={(title) => setDraft({ ...draft, title })}
            />
            <TextInput
              accessibilityLabel="Prompt text"
              className="min-h-40 rounded-2xl bg-card p-4 text-base text-foreground"
              maxLength={CUSTOM_PROMPT_BODY_MAX_CHARS}
              multiline
              placeholder="Prompt"
              textAlignVertical="top"
              value={draft.prompt}
              onChangeText={(prompt) => setDraft({ ...draft, prompt })}
            />
            <View className="flex-row justify-end gap-3">
              <Pressable
                accessibilityRole="button"
                className="min-h-11 justify-center rounded-full px-5 active:bg-subtle"
                onPress={() => setDraft(null)}
              >
                <Text className="text-base font-t3-bold text-foreground">Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                className="min-h-11 justify-center rounded-full bg-primary px-5 active:opacity-70"
                onPress={saveDraft}
              >
                <Text className="text-base font-t3-bold text-primary-foreground">Save</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </Modal>
    </View>
  );
}
