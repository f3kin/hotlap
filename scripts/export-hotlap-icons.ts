#!/usr/bin/env node

// Renders every Hotlap icon from assets/hotlap/mark.svg with sharp.
//
// Upstream renders its icons from Icon Composer projects (scripts/export-brand-icons.ts
// and scripts/export-android-icons.ts). Hotlap keeps those scripts untouched and the
// output filenames identical, but generates the files here so the fork does not depend
// on Icon Composer or on the T3 wordmark's geometry. The Icon Composer projects still
// exist because Expo builds the iOS icon from them: this script rewrites their single
// layer with a flattened (solid-colour) copy of the mark that actool can rasterize.
// Upstream's extra layer files (clouds, annotations) stay on disk, unreferenced, so
// upstream edits to them never conflict with the fork.
//
// Run from the repository root: `node scripts/export-hotlap-icons.ts`.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import sharp from "sharp";

import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

type Variant = "prod" | "nightly" | "dev";

const MARK_PATH = "assets/hotlap/mark.svg";
const MOBILE_ASSETS = "apps/mobile/assets";

// The mark's visible bounds inside its 100pt viewBox: the ring is centred at
// (50, 50) with an outer radius of 44.
const MARK_CENTER = { x: 50, y: 50 };
const MARK_EXTENT = 88;
// Solid replacement for the arc gradient wherever a single-colour mark is needed.
const ARC_SOLID = "#FF5A2E";

// Android: 108dp adaptive canvas at xxxhdpi. The launcher shows the central 72dp,
// so the mark spans 46 % of the canvas to stay inside the safe zone with margin.
const ADAPTIVE = 432;
const ADAPTIVE_FRACTION = 0.46;
const SPLASH = 1152;

const VARIANTS: Record<
  Variant,
  { readonly background: string; readonly prefix: string; readonly composerFill: string }
> = {
  prod: { background: "#000000", prefix: "black", composerFill: "0.00000,0.00000,0.00000" },
  nightly: { background: "#1C1C1E", prefix: "nightly", composerFill: "0.10980,0.10980,0.11765" },
  dev: { background: "#1D4ED8", prefix: "blueprint", composerFill: "0.11373,0.30588,0.84706" },
};

// Upstream's web/Windows renditions carry a `t3-` prefix for production only.
const webPrefix = (variant: Variant) =>
  variant === "prod" ? "t3-black" : VARIANTS[variant].prefix;

export class HotlapIconRenderError extends Schema.TaggedError<HotlapIconRenderError>()(
  "HotlapIconRenderError",
  { output: Schema.String, cause: Schema.Defect() },
) {}

interface Mark {
  readonly defs: string;
  readonly body: string;
}

const roundedRect = (x: number, y: number, size: number, radius: number, fill: string) =>
  `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${radius}" fill="${fill}"/>`;

/** The mark, scaled so its visible extent spans `fraction` of `size`, centred at `cx,cy`. */
const placedMark = (
  mark: Mark,
  size: number,
  fraction: number,
  options: { readonly cx?: number; readonly cy?: number; readonly mono?: string } = {},
) => {
  const scale = (size * fraction) / MARK_EXTENT;
  const tx = (options.cx ?? size / 2) - MARK_CENTER.x * scale;
  const ty = (options.cy ?? size / 2) - MARK_CENTER.y * scale;
  const body = options.mono
    ? mark.body.replace(/fill="[^"]*"/g, `fill="${options.mono}"`)
    : mark.body;
  return `<g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${scale.toFixed(5)})">${body}</g>`;
};

const canvas = (size: number, inner: string, defs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none">${defs}${inner}</svg>`;

const rasterize = (output: string, svg: string) =>
  Effect.tryPromise({
    try: () => sharp(Buffer.from(svg)).png().toBuffer(),
    catch: (cause) => new HotlapIconRenderError({ output, cause }),
  });

const resize = (output: string, png: Buffer, size: number) =>
  Effect.tryPromise({
    try: () => sharp(png).resize(size, size, { kernel: "lanczos3" }).png().toBuffer(),
    catch: (cause) => new HotlapIconRenderError({ output, cause }),
  });

// iOS masks its icons itself, but the same file feeds Linux and the web favicons, so
// the rendition carries the iOS silhouette (22.37 % corner radius) like upstream's.
const renderSquircle = (mark: Mark, variant: Variant, size: number) =>
  rasterize(
    `${variant}-${size}`,
    canvas(
      size,
      roundedRect(0, 0, size, size * 0.2237, VARIANTS[variant].background) +
        placedMark(mark, size, 0.64),
      mark.defs,
    ),
  );

// Classic macOS safe area: an 824 px body inset 100 px on a 1024 canvas.
const renderMac = (mark: Mark, variant: Variant) =>
  rasterize(
    `${variant}-macos`,
    canvas(
      1024,
      roundedRect(100, 100, 824, 185, VARIANTS[variant].background) +
        placedMark(mark, 824, 0.6, { cx: 512, cy: 512 }),
      mark.defs,
    ),
  );

const renderIco = Effect.fn("hotlapIcons.renderIco")(function* (mark: Mark, variant: Variant) {
  const renditions = yield* Effect.forEach(WINDOWS_ICON_SIZES, (size) =>
    renderSquircle(mark, variant, size).pipe(Effect.map((contents) => ({ size, contents }))),
  );
  return yield* Effect.try({
    try: () => encodePngIco(renditions),
    catch: (cause) => new HotlapIconRenderError({ output: `${variant}-ico`, cause }),
  });
});

const renderSolid = (output: string, size: number, fill: string) =>
  rasterize(output, canvas(size, `<rect width="${size}" height="${size}" fill="${fill}"/>`));

const renderSplash = (mark: Mark, variant: Variant) =>
  rasterize(
    `${variant}-splash`,
    canvas(
      SPLASH,
      `<rect width="${SPLASH}" height="${SPLASH}" fill="${VARIANTS[variant].background}"/>` +
        placedMark(mark, SPLASH, ADAPTIVE_FRACTION),
      mark.defs,
    ),
  );

// Icon Composer layer: a 128pt source scaled 7.7× on the 1024pt canvas puts the mark at
// the same 64 % the raster renditions use. Solid fills only; actool's SVG support is thin.
const composerLayerSvg = (mark: Mark) => {
  const tx = 64 - MARK_CENTER.x;
  const ty = 64 - MARK_CENTER.y;
  const body = mark.body.replace(/fill="url\(#[^)]*\)"/g, `fill="${ARC_SOLID}"`);
  return `<svg width="128" height="128" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">\n  <g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)})">${body}</g>\n</svg>\n`;
};

const composerProject = (variant: Variant) =>
  JSON.stringify(
    {
      fill: { solid: `display-p3:${VARIANTS[variant].composerFill},1.00000` },
      groups: [
        {
          layers: [
            {
              "image-name": "text.svg",
              name: "Mark",
              position: { scale: 7.7, "translation-in-points": [0, 0] },
            },
          ],
          shadow: { kind: "neutral", opacity: 0.5 },
          translucency: { enabled: true, value: 0.5 },
        },
      ],
      "supported-platforms": { circles: ["watchOS"], squares: "shared" },
    },
    null,
    2,
  ) + "\n";

const loadMark = Effect.fn("hotlapIcons.loadMark")(function* (repositoryRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const svg = yield* fs.readFileString(path.join(repositoryRoot, MARK_PATH));
  return {
    defs: svg.match(/<defs>[\s\S]*?<\/defs>/)?.[0] ?? "",
    body: svg
      .replace(/^[\s\S]*?<\/defs>/, "")
      .replace(/<title>[\s\S]*?<\/title>/, "")
      .replace(/<\/svg>\s*$/, "")
      .trim(),
  } satisfies Mark;
});

const write = Effect.fn("hotlapIcons.write")(function* (
  repositoryRoot: string,
  relativePath: string,
  contents: Uint8Array | string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(repositoryRoot, relativePath);
  yield* fs.makeDirectory(path.dirname(target), { recursive: true });
  if (typeof contents === "string") {
    yield* fs.writeFileString(target, contents);
  } else {
    yield* fs.writeFile(target, contents);
  }
  yield* Console.log(`wrote ${relativePath}`);
});

const exportVariant = Effect.fn("hotlapIcons.exportVariant")(function* (
  repositoryRoot: string,
  mark: Mark,
  variant: Variant,
) {
  const dir = `assets/${variant}`;
  const { prefix } = VARIANTS[variant];
  const web = webPrefix(variant);
  const ios = yield* renderSquircle(mark, variant, 1024);
  const ico = yield* renderIco(mark, variant);
  const outputs: ReadonlyArray<readonly [string, Uint8Array | string]> = [
    [`${dir}/${prefix}-ios-1024.png`, ios],
    [`${dir}/${prefix}-universal-1024.png`, ios],
    [`${dir}/${prefix}-macos-1024.png`, yield* renderMac(mark, variant)],
    [`${dir}/${web}-web-apple-touch-180.png`, yield* resize(`${variant}-180`, ios, 180)],
    [`${dir}/${web}-web-favicon-16x16.png`, yield* renderSquircle(mark, variant, 16)],
    [`${dir}/${web}-web-favicon-32x32.png`, yield* renderSquircle(mark, variant, 32)],
    [`${dir}/${web}-web-favicon.ico`, ico],
    [`${dir}/${web}-windows.ico`, ico],
    [`${dir}/app-icon.icon/Assets/text.svg`, composerLayerSvg(mark)],
    [`${dir}/app-icon.icon/icon.json`, composerProject(variant)],
  ];
  for (const [relativePath, contents] of outputs) {
    yield* write(repositoryRoot, relativePath, contents);
  }
});

const exportAndroid = Effect.fn("hotlapIcons.exportAndroid")(function* (
  repositoryRoot: string,
  mark: Mark,
) {
  const outputs: ReadonlyArray<readonly [string, Uint8Array]> = [
    [
      "android-icon-foreground.png",
      yield* rasterize(
        "android-foreground",
        canvas(ADAPTIVE, placedMark(mark, ADAPTIVE, ADAPTIVE_FRACTION), mark.defs),
      ),
    ],
    [
      "android-icon-mark.png",
      yield* rasterize(
        "android-mark",
        canvas(ADAPTIVE, placedMark(mark, ADAPTIVE, ADAPTIVE_FRACTION, { mono: "#FFFFFF" })),
      ),
    ],
    [
      "android-notification-icon.png",
      yield* rasterize(
        "android-notification",
        canvas(96, placedMark(mark, 96, 0.8, { mono: "#FFFFFF" })),
      ),
    ],
    [
      "android-icon-background-nightly.png",
      yield* renderSolid("android-background-nightly", ADAPTIVE, VARIANTS.nightly.background),
    ],
    [
      "android-icon-background-dev.png",
      yield* renderSolid("android-background-dev", ADAPTIVE, VARIANTS.dev.background),
    ],
    ["android-splash-icon-prod.png", yield* renderSplash(mark, "prod")],
    ["android-splash-icon-nightly.png", yield* renderSplash(mark, "nightly")],
    ["android-splash-icon-dev.png", yield* renderSplash(mark, "dev")],
  ];
  for (const [name, contents] of outputs) {
    yield* write(repositoryRoot, `${MOBILE_ASSETS}/${name}`, contents);
  }
});

// The committed dev-brand copies the web app serves in development.
const exportWebPublic = Effect.fn("hotlapIcons.exportWebPublic")(function* (
  repositoryRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const copies = [
    ["assets/dev/blueprint-web-favicon.ico", "apps/web/public/favicon.ico"],
    ["assets/dev/blueprint-web-favicon-16x16.png", "apps/web/public/favicon-16x16.png"],
    ["assets/dev/blueprint-web-favicon-32x32.png", "apps/web/public/favicon-32x32.png"],
    ["assets/dev/blueprint-web-apple-touch-180.png", "apps/web/public/apple-touch-icon.png"],
  ] as const;
  for (const [source, target] of copies) {
    const contents = yield* fs.readFile(path.join(repositoryRoot, source));
    yield* write(repositoryRoot, target, contents);
  }
});

const exportHotlapIcons = Effect.gen(function* () {
  const path = yield* Path.Path;
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const mark = yield* loadMark(repositoryRoot);
  for (const variant of ["prod", "nightly", "dev"] as const) {
    yield* exportVariant(repositoryRoot, mark, variant);
  }
  yield* exportAndroid(repositoryRoot, mark);
  yield* exportWebPublic(repositoryRoot);
});

if (import.meta.main) {
  exportHotlapIcons.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
