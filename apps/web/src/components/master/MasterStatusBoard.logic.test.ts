import { describe, expect, it } from "vite-plus/test";

import {
  deriveMasterBoard,
  isCardThreadTitle,
  isMasterThreadTitle,
  type MasterBoardThread,
} from "./MasterStatusBoard.logic";

function thread(
  id: string,
  title: string,
  options: Partial<MasterBoardThread> = {},
): MasterBoardThread {
  return {
    id,
    title,
    environmentId: "personal-vps",
    projectId: "hourglass-infra",
    updatedAt: "2026-09-16T00:00:00.000Z",
    ...options,
  };
}

describe("MasterStatusBoard logic", () => {
  it("recognises Master and Card prefixes without depending on casing or spacing", () => {
    expect(isMasterThreadTitle(" Master: Fleet")).toBe(true);
    expect(isMasterThreadTitle("master : Brain")).toBe(true);
    expect(isCardThreadTitle("CARD: Verify deploy")).toBe(true);
    expect(isCardThreadTitle("Fleet planning")).toBe(false);
  });

  it("associates cards through direct and nested fork lineage", () => {
    const master = thread("master", "Master: Fleet");
    const direct = thread("direct", "Card: Direct", {
      forkedFrom: { threadId: master.id },
    });
    const nested = thread("nested", "Card: Nested", {
      forkedFrom: { threadId: direct.id },
    });

    expect(deriveMasterBoard(master, [master, direct, nested])?.cards).toEqual([direct, nested]);
  });

  it("keeps unowned cards out of a board, even when there is one Master", () => {
    const master = thread("master", "Master: Fleet");
    const unowned = thread("unowned", "Card: Existing work");

    expect(deriveMasterBoard(master, [master, unowned])?.cards).toEqual([]);
  });

  it("does not guess ownership when a project has multiple Masters", () => {
    const fleet = thread("fleet", "Master: Fleet");
    const migration = thread("migration", "Master: Migration");
    const linked = thread("linked", "Card: Fleet check", {
      forkedFrom: { threadId: fleet.id },
    });
    const ambiguous = thread("ambiguous", "Card: Old card");

    const board = deriveMasterBoard(fleet, [fleet, migration, linked, ambiguous]);

    expect(board?.cards).toEqual([linked]);
    expect(board?.peerMasters).toEqual([migration]);
  });

  it("assigns cards to their nearest Master ancestor", () => {
    const fleet = thread("fleet", "Master: Fleet");
    const migration = thread("migration", "Master: Migration", {
      forkedFrom: { threadId: fleet.id },
    });
    const card = thread("card", "Card: Migration check", {
      forkedFrom: { threadId: migration.id },
    });

    expect(deriveMasterBoard(fleet, [fleet, migration, card])?.cards).toEqual([]);
    expect(deriveMasterBoard(migration, [fleet, migration, card])?.cards).toEqual([card]);
  });

  it("keeps completed and stale cards with their owning Master", () => {
    const master = thread("master", "Master: Fleet");
    const completed = thread("completed", "Card: Completed", {
      forkedFrom: { threadId: master.id },
      updatedAt: "2026-09-01T00:00:00.000Z",
      settledOverride: "settled",
    });
    const stale = thread("stale", "Card: Stale", {
      forkedFrom: { threadId: master.id },
      updatedAt: "2026-08-01T00:00:00.000Z",
    });

    expect(deriveMasterBoard(master, [master, stale, completed])?.cards).toEqual([
      completed,
      stale,
    ]);
  });

  it("excludes archived cards but retains their lineage for a live descendant", () => {
    const master = thread("master", "Master: Fleet");
    const archivedParent = thread("archived-parent", "Card: Archived parent", {
      forkedFrom: { threadId: master.id },
      archivedAt: "2026-09-10T00:00:00.000Z",
    });
    const liveChild = thread("live-child", "Card: Live child", {
      forkedFrom: { threadId: archivedParent.id },
    });

    expect(deriveMasterBoard(master, [master, archivedParent, liveChild])?.cards).toEqual([
      liveChild,
    ]);
  });

  it("omits cards whose missing live-shell ancestor prevents ownership resolution", () => {
    const master = thread("master", "Master: Fleet");
    const child = thread("child", "Card: Child", { forkedFrom: { threadId: "missing-parent" } });

    expect(deriveMasterBoard(master, [master, child])?.cards).toEqual([]);
  });

  it("ignores broken lineage and cycles, and sorts equal or malformed timestamps consistently", () => {
    const master = thread("master", "Master: Fleet");
    const broken = thread("broken", "Card: Missing parent", {
      forkedFrom: { threadId: "missing" },
    });
    const cycleA = thread("cycle-a", "Card: Cycle A", { forkedFrom: { threadId: "cycle-b" } });
    const cycleB = thread("cycle-b", "Card: Cycle B", { forkedFrom: { threadId: "cycle-a" } });
    const alpha = thread("alpha", "Card: Alpha", {
      forkedFrom: { threadId: master.id },
      updatedAt: "not-a-date",
    });
    const zulu = thread("zulu", "Card: Zulu", {
      forkedFrom: { threadId: master.id },
      updatedAt: "not-a-date",
    });

    expect(deriveMasterBoard(master, [master, broken, cycleA, cycleB, zulu, alpha])?.cards).toEqual([
      alpha,
      zulu,
    ]);
  });

  it("isolates projects and environments", () => {
    const master = thread("master", "Master: Fleet");
    const otherProject = thread("other-project", "Card: Wrong project", {
      projectId: "personal-brand",
      forkedFrom: { threadId: master.id },
    });
    const otherEnvironment = thread("other-environment", "Card: Wrong environment", {
      environmentId: "agent-vps",
      forkedFrom: { threadId: master.id },
    });

    expect(deriveMasterBoard(master, [master, otherProject, otherEnvironment])?.cards).toEqual([]);
  });

  it("returns no board for an ordinary thread", () => {
    const ordinary = thread("ordinary", "Fix the sidebar");
    expect(deriveMasterBoard(ordinary, [ordinary])).toBeNull();
  });
});
