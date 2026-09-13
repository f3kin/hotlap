import { assert, it } from "@effect/vitest";

import { formatCliCommand } from "./invocation.ts";

it("formats package runner commands from their cache entry paths", () => {
  for (const [entryPath, expected] of [
    ["/home/theo/.npm/_npx/abc123/node_modules/hotlap/dist/bin.mjs", "npx hotlap serve"],
    [
      "C:\\Users\\theo\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\hotlap\\dist\\bin.mjs",
      "npx hotlap serve",
    ],
    ["/home/theo/.cache/pnpm/dlx/abc/node_modules/hotlap/dist/bin.mjs", "pnpm dlx hotlap serve"],
    [
      "/home/theo/.local/share/pnpm/.pnpm/dlx/abc/node_modules/hotlap/dist/bin.mjs",
      "pnpm dlx hotlap serve",
    ],
    [
      "C:\\Users\\theo\\AppData\\Local\\pnpm-cache\\dlx\\abc\\node_modules\\hotlap\\dist\\bin.mjs",
      "pnpm dlx hotlap serve",
    ],
    ["/home/theo/.bun/install/cache/hotlap@0.0.31/dist/bin.mjs", "bunx hotlap serve"],
    ["/tmp/bunx-1000-hotlap@latest/node_modules/hotlap/dist/bin.mjs", "bunx hotlap serve"],
    [
      "C:\\Users\\theo\\AppData\\Local\\Temp\\bunx-0-hotlap@latest\\node_modules\\hotlap\\dist\\bin.mjs",
      "bunx hotlap serve",
    ],
  ] as const) {
    assert.equal(formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }), expected);
  }
});

it("treats stable installs as direct invocations", () => {
  for (const entryPath of [
    "/usr/local/lib/node_modules/hotlap/dist/bin.mjs",
    "/home/theo/Code/work/t3code/apps/server/dist/bin.mjs",
    "/home/theo/.hotlap/runtime/0.0.31/node_modules/hotlap/dist/bin.mjs",
    "",
  ]) {
    assert.equal(
      formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }),
      "hotlap serve",
    );
  }
});

it("re-suggests the nightly channel only for nightly builds", () => {
  for (const [version, expected] of [
    ["0.0.31-nightly.20260729", "npx hotlap@nightly serve"],
    ["0.0.31", "npx hotlap serve"],
  ] as const) {
    assert.equal(
      formatCliCommand({
        subcommand: "serve",
        entryPath: "/home/theo/.npm/_npx/abc123/node_modules/hotlap/dist/bin.mjs",
        version,
      }),
      expected,
    );
  }
});

it("formats serve suggestions to match the launching command", () => {
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/home/theo/.npm/_npx/abc/node_modules/hotlap/dist/bin.mjs",
      version: "0.0.31-nightly.20260729",
    }),
    "npx hotlap@nightly serve",
  );
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/tmp/bunx-1000-hotlap@latest/node_modules/hotlap/dist/bin.mjs",
      version: "0.0.31",
    }),
    "bunx hotlap serve",
  );
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/usr/local/lib/node_modules/hotlap/dist/bin.mjs",
      version: "0.0.31-nightly.20260729",
    }),
    "hotlap serve",
  );
});
