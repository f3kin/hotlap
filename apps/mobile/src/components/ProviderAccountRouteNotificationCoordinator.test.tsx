import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: vi.fn() },
  Pressable: "Pressable",
  View: "View",
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock("../features/keyboard/hardwareKeyboardCommands", () => ({
  parseActiveThreadPath: () => null,
}));
vi.mock("../state/threads", () => ({ useEnvironmentThread: vi.fn() }));
vi.mock("./AppText", () => ({ AppText: "Text" }));

import { ProviderAccountRouteBanner } from "./ProviderAccountRouteNotificationCoordinator";

type InspectableElement = ReactElement<Record<string, unknown>>;

function nodes(root: ReactNode): InspectableElement[] {
  if (!root || typeof root !== "object" || !("props" in root)) return [];
  const element = root as InspectableElement;
  const children = Array.isArray(element.props.children)
    ? element.props.children
    : [element.props.children];
  return [element, ...children.flatMap(nodes)];
}

describe("provider account route banner", () => {
  it("is a dismissible foreground alert with the route copy", () => {
    const onDismiss = vi.fn();
    const tree = nodes(
      ProviderAccountRouteBanner({
        notification: {
          activityId: "route-1",
          kind: "success",
          title: "Switched Claude: Personal → Work",
          description: "Continuing this thread.",
        },
        onDismiss,
        topInset: 12,
      }),
    );

    expect(tree.some((node) => node.props.accessibilityRole === "alert")).toBe(true);
    const dismiss = tree.find((node) => node.props.accessibilityLabel === "Dismiss notification");
    expect(dismiss).toBeDefined();
    const onPress = dismiss?.props.onPress;
    if (typeof onPress === "function") onPress();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
