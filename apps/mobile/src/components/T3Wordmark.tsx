import type { ColorValue } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);
const ThemedCircle = withUniwind(Circle);

/**
 * The Hotlap mark, matching the desktop sidebar's T3Wordmark SVG
 * (apps/web Sidebar.tsx). The mark is square, so width equals height.
 */
export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg
      accessibilityLabel="Hotlap"
      height={props.height}
      width={props.height}
      viewBox="5.26 8.78 85.5 85.5"
    >
      <ThemedPath
        d="M76.855 19.970A42.75 42.75 0 1 0 80.062 79.820A2.75 2.75 0 0 0 75.938 76.180A37.25 37.25 0 1 1 73.145 24.030A2.75 2.75 0 0 0 76.855 19.970ZM31 54L38 46H46C50 46 53 44.5 56.5 41L58 39.5H79L73.5 47H56C52 47 49 48.5 45.5 52L43.5 54H31ZM23 64L30.5 56H39C43 56 46 54.5 49.5 51L51 49.5H70L64.5 57H49C45 57 42 58.5 38.5 62L36.5 64H23Z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
      <ThemedCircle
        cx={80.5}
        cy={29.5}
        r={3.3}
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
