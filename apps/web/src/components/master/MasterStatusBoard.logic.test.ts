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

  it("includes legacy unlinked cards when the project has one Master", () => {
    const master = thread("master", "Master: Fleet");
    const legacy = thread("legacy", "Card: Existing work");

    expect(deriveMasterBoard(master, [master, legacy])?.cards).toEqual([legacy]);
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
