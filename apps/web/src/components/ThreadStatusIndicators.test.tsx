import { ThreadId, type ThreadPullRequestLink } from "@t3tools/contracts";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  ThreadPullRequestBadgeControl,
  ThreadWorktreeIndicator,
  linkedPullRequestSnapshotStatus,
  prStatusIndicator,
} from "./ThreadStatusIndicators";
import { ComposerControl } from "./chat/ComposerControl";
import { InlineButton } from "./ui/button";

describe("ThreadWorktreeIndicator", () => {
  it("renders the worktree folder and branch in an accessible label", () => {
    const markup = renderToStaticMarkup(
      <ThreadWorktreeIndicator
        thread={{
          id: ThreadId.make("thread-1"),
          branch: "feature/sidebar-indicator",
          worktreePath: "/tmp/worktrees/sidebar-indicator",
        }}
      />,
    );

    expect(markup).toContain('role="img"');
    expect(markup).toContain(
      'aria-label="Worktree: sidebar-indicator (feature/sidebar-indicator)"',
    );
    expect(markup).toContain('data-testid="thread-worktree-thread-1"');
  });

  it.each([null, "", "   "])("renders nothing for an absent worktree path", (worktreePath) => {
    const markup = renderToStaticMarkup(
      <ThreadWorktreeIndicator
        thread={{
          id: ThreadId.make("thread-1"),
          branch: "main",
          worktreePath,
        }}
      />,
    );

    expect(markup).toBe("");
  });
});

describe("linked pull request snapshots", () => {
  const link: ThreadPullRequestLink = {
    host: "gitlab.example.com",
    repository: "acme/web",
    number: 42,
    url: "https://gitlab.example.com/acme/web/-/merge_requests/42",
    source: "manual",
    linkedAt: "2026-01-01T00:00:00Z",
    stack: null,
    snapshot: null,
  };
  it("keeps unsynced links unknown", () => {
    expect(linkedPullRequestSnapshotStatus(link)).toBeNull();
  });
  it("uses the snapshot state and branches with the linked identity", () => {
    const result = linkedPullRequestSnapshotStatus({
      ...link,
      snapshot: {
        state: "merged",
        title: "Change",
        headBranch: "feature",
        baseBranch: "main",
        isDraft: false,
        updatedAt: "2026-01-02T00:00:00Z",
        syncedAt: "2026-01-03T00:00:00Z",
      },
    });
    expect(result).toEqual({
      pr: {
        number: 42,
        url: link.url,
        title: "Change",
        state: "merged",
        isDraft: false,
        headRef: "feature",
        baseRef: "main",
        updatedAt: "2026-01-02T00:00:00Z",
      },
      sourceControlProvider: { kind: "gitlab", name: "gitlab", baseUrl: "" },
    });
  });
});

describe("ThreadPullRequestBadgeControl", () => {
  const merged = prStatusIndicator(
    {
      number: 370,
      url: "https://github.com/example/orchard/pull/370",
      title: "Change",
      state: "merged",
      isDraft: false,
      headRef: "feature",
      baseRef: "main",
      updatedAt: "2026-01-02T00:00:00Z",
    },
    null,
  );

  function renderBadge(render: ReactElement) {
    const html = renderToStaticMarkup(
      <ThreadPullRequestBadgeControl
        render={render}
        badge={null}
        number={370}
        url="https://github.com/example/orchard/pull/370"
        status={merged}
        onOpenStack={() => {}}
        onOpenPullRequest={() => {}}
      />,
    );
    const link = html.match(/<a [^>]*class="([^"]*)"/)?.[1]?.split(" ") ?? [];
    return { html, link };
  }

  it("sets the meta size and normal weight on the control itself, over the InlineButton's", () => {
    const { link } = renderBadge(<InlineButton />);

    expect(link).toContain("text-xs");
    expect(link).toContain("font-normal");
    expect(link).not.toContain("font-medium");
  });

  it.each([
    ["an InlineButton", () => <InlineButton />],
    ["a ComposerControl", () => <ComposerControl size="xs" />],
  ])(
    "keeps the state tone on the icon and number inside %s, whatever its hover colour",
    (_, control) => {
      const tone = merged!.colorClass;
      const { html, link } = renderBadge(control());
      // The glyph and number sit in a wrapper that carries the tone and no hover or focus
      // colour, so the control's own hover:text-* can never repaint them.
      const wrapper = html.match(/<span class="([^"]*)"><svg/)?.[1] ?? "";

      expect(link.join(" ")).toContain("text-xs");
      expect(wrapper).toContain(tone);
      expect(wrapper).not.toMatch(/(hover|focus[a-z-]*):/);
      expect(html).toMatch(/<svg[^>]*>.*<\/svg>#?370<\/span>/);
    },
  );
});
