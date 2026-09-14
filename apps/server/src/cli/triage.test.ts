import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { resolveTriagePaths } from "./triage.ts";

it.effect.each(["hotlap", "legacy", "flag"] as const)(
  "triage reads and writes only the selected %s profile",
  (source) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "hotlap-triage-home-" });
      const hotlap = path.join(root, "hotlap");
      const legacy = path.join(root, "legacy");
      const explicit = path.join(root, "explicit");
      const paths = yield* resolveTriagePaths(
        source === "flag" ? Option.some(explicit) : Option.none(),
      ).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_HOME: legacy,
                ...(source === "legacy" ? {} : { HOTLAP_HOME: hotlap }),
              },
            }),
          ),
        ),
      );
      const selected = source === "flag" ? explicit : source === "legacy" ? legacy : hotlap;
      assert.equal(paths.baseDir, selected);
      assert.equal(paths.stateDir, path.join(selected, "userdata"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
