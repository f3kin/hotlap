// @effect-diagnostics nodeBuiltinImport:off - Exercise the publisher subprocess with an isolated package-manager boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";
import { it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { fromYaml } from "@t3tools/shared/schemaYaml";

import { resolveWebIconOverrides } from "./lib/brand-assets.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const repo = NodeURL.fileURLToPath(new URL("..", import.meta.url));

const Step = Schema.Struct({
  env: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  name: Schema.optional(Schema.String),
  run: Schema.optional(Schema.String),
  uses: Schema.optional(Schema.String),
  with: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const Workflow = fromYaml(
  Schema.Struct({
    concurrency: Schema.optional(
      Schema.Struct({
        group: Schema.String,
      }),
    ),
    jobs: Schema.Record(
      Schema.String,
      Schema.Struct({
        if: Schema.optional(Schema.String),
        needs: Schema.optional(Schema.Array(Schema.String)),
        outputs: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
        uses: Schema.optional(Schema.String),
        "runs-on": Schema.optional(Schema.String),
        with: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
        steps: Schema.optional(Schema.Array(Step)),
      }),
    ),
  }),
);
const decodeWorkflow = Schema.decodeUnknownSync(Workflow);
const PublishObservation = Schema.fromJsonString(
  Schema.Struct({
    metadata: Schema.Struct({
      name: Schema.String,
      bin: Schema.Record(Schema.String, Schema.String),
      version: Schema.String,
      repository: Schema.Struct({ url: Schema.String }),
    }),
    args: Schema.Array(Schema.String),
    icon: Schema.String,
  }),
);
const decodePublishObservation = Schema.decodeUnknownSync(PublishObservation);

it("keeps release outputs on Hotlap and gates npm on every native target", async () => {
  const release = decodeWorkflow(
    await NodeFSP.readFile(NodePath.join(repo, ".github/workflows/release.yml"), "utf8"),
  );
  const desktop = decodeWorkflow(
    await NodeFSP.readFile(NodePath.join(repo, ".github/workflows/release-desktop.yml"), "utf8"),
  );
  const publish = release.jobs.publish_cli!;
  const resolveCommit = release.jobs.resolve_commit!;
  const preflight = release.jobs.preflight!;
  const resolveVersion = preflight.steps?.find((step) => step.name === "Resolve release version");
  const resolveCommitScript = resolveCommit.steps?.find(
    (step) => step.name === "Resolve release commit",
  )?.with?.script;
  NodeAssert.equal(
    release.concurrency?.group,
    "release-${{ inputs.channel == 'preview' && 'preview' || 'published' }}",
  );
  NodeAssert.equal(
    resolveCommit.outputs?.next_nightly_version,
    "${{ steps.resolve.outputs.next_nightly_version }}",
  );
  NodeAssert.equal(
    resolveVersion?.env?.NIGHTLY_BASE_VERSION,
    "${{ needs.resolve_commit.outputs.next_nightly_version }}",
  );
  NodeAssert.ok(
    resolveVersion?.run?.includes('nightly_base_args=(--base-version "$NIGHTLY_BASE_VERSION")'),
  );
  NodeAssert.ok(resolveVersion?.run?.includes('"${nightly_base_args[@]}"'));
  NodeAssert.ok(!resolveVersion?.run?.includes("DISPATCH_VERSION"));
  NodeAssert.ok(resolveVersion?.run?.includes("^[0-9]+\\.[0-9]+\\.[0-9]+$"));
  NodeAssert.ok(String(resolveCommitScript).includes("assertReleaseVersionIsCurrent"));
  NodeAssert.ok(
    String(resolveCommitScript).includes("releaseChannel: 'stable', version"),
    "stable dispatch must reject an obsolete nightly before building",
  );
  const targets = Object.entries(release.jobs).filter(
    ([, job]) => job.uses === "./.github/workflows/release-desktop.yml",
  );
  NodeAssert.equal(targets.length, 6);
  for (const [name, job] of targets) {
    NodeAssert.ok(publish.needs?.includes(name), `${name} must finish before npm publishes`);
    NodeAssert.ok(publish.if?.includes(`needs.${name}.result == 'success'`));
    NodeAssert.ok(!String(job.with?.runner).includes("blacksmith"));
  }
  const steps = publish.steps ?? [];
  const revalidateIndex = steps.findIndex((step) => step.name === "Revalidate release version");
  const publishIndex = steps.findIndex((step) => step.name === "Publish CLI package");
  NodeAssert.ok(revalidateIndex >= 0 && revalidateIndex < publishIndex);
  NodeAssert.equal(steps[revalidateIndex]?.uses, "actions/github-script@v8");
  NodeAssert.ok(
    String(steps[revalidateIndex]?.with?.script).includes("assertReleaseVersionIsCurrent"),
  );
  NodeAssert.equal(
    steps.find((step) => step.name === "Download JS bundle")?.with?.name,
    "js-bundle",
  );
  NodeAssert.equal(
    steps.find((step) => step.name === "Download resource monitors")?.with?.pattern,
    "resource-monitor-*",
  );
  const publisher = steps.find((step) => step.name === "Publish CLI package")?.run;
  NodeAssert.ok(publisher?.includes("--app-version"));
  NodeAssert.ok(!steps.some((step) => step.run?.includes("build-npm-platform-packages")));
  for (const name of [
    "publish_aur",
    "deploy_web",
    "deploy_marketing",
    "finalize",
    "announce_discord",
  ]) {
    NodeAssert.ok(
      release.jobs[name]?.if?.includes("github.repository == 'pingdotgg/t3code'"),
      `${name} must stay disabled in Hotlap`,
    );
  }
  NodeAssert.ok(release.jobs.release?.steps?.some((step) => step.name === "Attach Android APK"));
  NodeAssert.ok(
    release.jobs.release?.steps?.some((step) => step.run?.includes("hotlap-*.tar.gz hotlap-*.zip")),
  );
  NodeAssert.ok(
    desktop.jobs.build?.steps?.some((step) => step.run?.includes("wsl-runtime/hotlap-*-linux-")),
  );
});

// Exercise the real publishing command, but replace the package-manager boundary
// in a disposable workspace. No registry request or checkout mutation is allowed.
// oxlint-disable-next-line t3code/no-global-process-runtime -- This fixture executes an actual POSIX package-manager shim.
it.skipIf(process.platform === "win32")(
  "publishes only hotlap and restores metadata and icons after a failed publish",
  async () => {
    const fixture = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hotlap-publish-"));
    try {
      for (const relative of [
        "apps/server/scripts/cli.ts",
        "apps/server/scripts/cliErrors.ts",
        "apps/server/package.json",
        "scripts/lib/brand-assets.ts",
        "scripts/lib/resolve-catalog.ts",
        "scripts/lib/cli-executable-imports.ts",
        "pnpm-workspace.yaml",
      ]) {
        const target = NodePath.join(fixture, relative);
        await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
        await NodeFSP.copyFile(NodePath.join(repo, relative), target);
      }
      await NodeFSP.writeFile(NodePath.join(fixture, "package.json"), '{"type":"module"}');
      await NodeFSP.symlink(
        NodePath.join(repo, "apps/server/node_modules"),
        NodePath.join(fixture, "apps/server/node_modules"),
        "dir",
      );
      await NodeFSP.symlink(
        NodePath.join(repo, "scripts/node_modules"),
        NodePath.join(fixture, "scripts/node_modules"),
        "dir",
      );
      for (const relative of [
        "dist/bin.mjs",
        "dist/service-launcher.mjs",
        "dist/client/index.html",
      ]) {
        const target = NodePath.join(fixture, "apps/server", relative);
        await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
        await NodeFSP.writeFile(target, "fixture build");
      }
      const icons = resolveWebIconOverrides("production", "dist/client");
      for (const icon of icons) {
        const source = NodePath.join(fixture, icon.sourceRelativePath);
        await NodeFSP.mkdir(NodePath.dirname(source), { recursive: true });
        await NodeFSP.writeFile(source, "publish icon");
        await NodeFSP.writeFile(
          NodePath.join(fixture, "apps/server", icon.targetRelativePath),
          "original icon",
        );
      }
      const pkgPath = NodePath.join(fixture, "apps/server/package.json");
      const original = await NodeFSP.readFile(pkgPath, "utf8");
      const bin = NodePath.join(fixture, "bin");
      await NodeFSP.mkdir(bin);
      await NodeFSP.writeFile(
        NodePath.join(bin, "vp"),
        `#!${process.execPath}
import * as NodeFS from "node:fs";
const metadata = JSON.parse(NodeFS.readFileSync("apps/server/package.json", "utf8"));
NodeFS.writeFileSync("publish-observation.json", JSON.stringify({ metadata, args: process.argv.slice(2), icon: NodeFS.readFileSync("apps/server/dist/client/favicon.ico", "utf8") }));
process.exit(17);
`,
        { mode: 0o755 },
      );
      await NodeAssert.rejects(
        exec(
          process.execPath,
          [
            NodePath.join(fixture, "apps/server/scripts/cli.ts"),
            "publish",
            "--app-version",
            "1.2.3",
            "--tag",
            "latest",
            "--dry-run",
          ],
          {
            cwd: fixture,
            env: {
              PATH: `${bin}${NodePath.delimiter}${process.env.PATH}`,
              HOME: fixture,
              CI: "true",
            },
            timeout: 30_000,
          },
        ),
      );
      const observation = decodePublishObservation(
        await NodeFSP.readFile(NodePath.join(fixture, "publish-observation.json"), "utf8"),
      );
      NodeAssert.equal(observation.metadata.name, "hotlap");
      NodeAssert.deepStrictEqual(observation.metadata.bin, { hotlap: "./dist/bin.mjs" });
      NodeAssert.equal(observation.metadata.version, "1.2.3");
      NodeAssert.equal(observation.metadata.repository.url, "https://github.com/shwarmadev/hotlap");
      NodeAssert.deepStrictEqual(observation.args, [
        "pm",
        "publish",
        "--filter",
        "./apps/server",
        "--access",
        "public",
        "--tag",
        "latest",
        "--no-git-checks",
        "--dry-run",
      ]);
      NodeAssert.equal(observation.icon, "publish icon");
      NodeAssert.equal(await NodeFSP.readFile(pkgPath, "utf8"), original);
      for (const icon of icons) {
        NodeAssert.equal(
          await NodeFSP.readFile(
            NodePath.join(fixture, "apps/server", icon.targetRelativePath),
            "utf8",
          ),
          "original icon",
        );
      }
    } finally {
      await NodeFSP.rm(fixture, { recursive: true, force: true });
    }
  },
);
