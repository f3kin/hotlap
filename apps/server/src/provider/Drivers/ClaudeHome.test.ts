import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  claudeSignedOutMessage,
  copyClaudeSession,
  makeClaudeCapabilitiesCacheKey,
  makeClaudeEnvironment,
  readClaudeLoginIdentity,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("treats empty, ~/.claude, and the expanded default as the same Claude home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(path.join(NodeOS.homedir(), ".claude"));

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude" })).toBe(resolved);
        expect(yield* resolveClaudeHomePath({ homePath: resolved })).toBe(resolved);
        expect(yield* makeClaudeEnvironment({ homePath: "" })).toBe(process.env);
      }),
    );

    it.effect("resolves configured Claude HOME and stamps the cache key with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("uses inherited CLAUDE_CONFIG_DIR when homePath is empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/tmp/claude-inherited");
        const environment = { CLAUDE_CONFIG_DIR: inherited };

        expect(yield* resolveClaudeHomePath({ homePath: "" }, environment)).toBe(inherited);

        const explicit = path.resolve(NodeOS.homedir(), ".claude-work");
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude-work" }, environment)).toBe(
          explicit,
        );
      }),
    );

    it("points the signed-out hint at the configured Claude home", () => {
      expect(claudeSignedOutMessage({ configDir: undefined, cwd: "/synthetic" })).toContain(
        "run `claude auth login`",
      );
      const configDir = "/synthetic/Claude work's $literal";
      const message = claudeSignedOutMessage({ configDir, cwd: "/synthetic/project" });
      expect(message).toContain(`CLAUDE_CONFIG_DIR set to "${configDir}"`);
      expect(message).not.toContain("CLAUDE_CONFIG_DIR=");
      expect(message).toContain("then start a new thread");
    });

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );

    it.effect("copies a session transcript and its sidecar into another Claude home", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped();
        const from = path.join(root, "personal");
        const to = path.join(root, "work");
        const sessionId = "0b7c8f0e-3f7a-4c1e-9a55-1f2d3c4b5a69";
        const project = path.join(from, "projects", "-repo");
        yield* fileSystem.makeDirectory(path.join(project, sessionId, "subagents"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(path.join(project, `${sessionId}.jsonl`), "new\n");
        yield* fileSystem.writeFileString(
          path.join(project, sessionId, "subagents", "a.jsonl"),
          "a",
        );
        // An older copy from an earlier move is replaced, not kept.
        yield* fileSystem.makeDirectory(path.join(to, "projects", "-repo"), { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(to, "projects", "-repo", `${sessionId}.jsonl`),
          "old\n",
        );

        expect(yield* copyClaudeSession({ fromConfigDir: from, toConfigDir: to, sessionId })).toBe(
          true,
        );
        expect(
          yield* fileSystem.readFileString(
            path.join(to, "projects", "-repo", `${sessionId}.jsonl`),
          ),
        ).toBe("new\n");
        expect(
          yield* fileSystem.readFileString(
            path.join(to, "projects", "-repo", sessionId, "subagents", "a.jsonl"),
          ),
        ).toBe("a");
        expect(
          yield* copyClaudeSession({
            fromConfigDir: from,
            toConfigDir: to,
            sessionId: "5d0c1d0e-0000-4000-8000-000000000000",
          }),
        ).toBe(false);
      }).pipe(Effect.scoped),
    );

    it.effect("reports an unreadable Claude home instead of a missing conversation", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped();
        const sessionId = "5d0c1d0e-0000-4000-8000-000000000000";
        const copy = (fromConfigDir: string) =>
          copyClaudeSession({ fromConfigDir, toConfigDir: path.join(root, "to"), sessionId });

        // A home that never ran Claude has nothing to copy.
        expect(yield* copy(path.join(root, "never-used"))).toBe(false);
        yield* fileSystem.makeDirectory(path.join(root, "broken"));
        yield* fileSystem.writeFileString(path.join(root, "broken", "projects"), "");
        const error = yield* Effect.flip(copy(path.join(root, "broken")));
        expect(error.reason._tag).not.toBe("NotFound");
      }).pipe(Effect.scoped),
    );

    it.effect("reads the signed-in subscription account from the config dir", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const configDir = yield* fileSystem.makeTempDirectoryScoped();
        const env = { CLAUDE_CONFIG_DIR: configDir };

        expect(yield* readClaudeLoginIdentity(env)).toBeUndefined();
        yield* fileSystem.writeFileString(
          path.join(configDir, ".claude.json"),
          '{"projects":{},"oauthAccount":{"accountUuid":"acct-1","organizationUuid":"org-1","emailAddress":"a@b"}}',
        );
        expect(yield* readClaudeLoginIdentity(env)).toBe("acct-1:org-1");
        yield* fileSystem.writeFileString(path.join(configDir, ".claude.json"), "{not json");
        expect(yield* readClaudeLoginIdentity(env)).toBeUndefined();
      }).pipe(Effect.scoped),
    );
  });
});
