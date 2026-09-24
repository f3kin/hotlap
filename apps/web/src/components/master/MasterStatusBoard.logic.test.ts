import { describe, expect, it } from "vite-plus/test";

import {
  deriveMasterBoard,
  deriveMasterWorkspace,
  isCardThreadTitle,
  isDisclosureOpen,
  isMasterThreadTitle,
  mergeLiveAndArchivedThreads,
  navigableRows,
  nextUnparkedKey,
  projectWorkSummary,
  disclosureKey,
  navigateDisclosure,
  setDisclosure,
  visibleWorkspaceRows,
  type Disclosure,
  type MasterBoardThread,
  type MasterShelf,
} from "./MasterStatusBoard.logic";

interface TestThread extends MasterBoardThread {
  readonly shelf?: MasterShelf;
}

function thread(id: string, title: string, options: Partial<TestThread> = {}): TestThread {
  return {
    id,
    title,
    environmentId: "env-a",
    projectId: "orchard",
    updatedAt: "2026-09-16T00:00:00.000Z",
    ...options,
  };
}

const ARCHIVED = "2026-09-10T00:00:00.000Z";

function workspace(threads: readonly TestThread[], projectIds: readonly string[] = []) {
  return deriveMasterWorkspace({
    threads,
    projects: projectIds.map((id) => ({ environmentId: "env-a", id })),
    shelfOf: (item) => item.shelf ?? "active",
  });
}

describe("deriveMasterWorkspace", () => {
  it("omits known projects that have no threads", () => {
    const master = thread("master", "Master: Harvest", { projectId: "orchard" });

    const model = workspace([master], ["orchard", "empty-greenhouse"]);

    expect(model.activeProjects.map((group) => group.projectId)).toEqual(["orchard"]);
  });

  it("files work under its shelf, keeping a Card with its Master across worktrees", () => {
    const master = thread("master", "Master: Harvest");
    const card = thread("card", "Card: Prune", {
      projectId: "orchard-worktree",
      forkedFrom: { threadId: master.id },
    });
    const chat = thread("chat", "Quick question");
    const snoozed = thread("snoozed", "Later question", { shelf: "snoozed" });
    const settledMaster = thread("settled-master", "Master: Done", {
      projectId: "barn",
      shelf: "settled",
    });

    const model = workspace([master, card, chat, snoozed, settledMaster], ["orchard", "barn"]);

    const orchard = model.activeProjects.find((group) => group.projectId === "orchard");
    expect(orchard?.masters[0]?.cards).toEqual([card]);
    expect(orchard?.oneOffs).toEqual([chat]);
    expect(model.snoozedProjects).toHaveLength(1);
    expect(model.snoozedProjects[0]?.oneOffs).toEqual([snoozed]);
    expect(model.settledProjects[0]).toMatchObject({ projectId: "barn", visibleCount: 1 });
  });

  it("keeps Cards without Master lineage in an explicit orphan fallback", () => {
    const master = thread("master", "Master: Harvest");
    const orphan = thread("orphan", "Card: Imported", { projectId: "imports" });

    const model = workspace([master, orphan]);

    expect(
      model.activeProjects.find((group) => group.projectId === "imports")?.orphanCards,
    ).toEqual([orphan]);
  });

  it("keeps an archived Master as the structural owner of its live Cards", () => {
    const archivedMaster = thread("master", "Master: Archived", { archivedAt: ARCHIVED });
    const archivedParent = thread("parent", "Card: Old parent", {
      archivedAt: ARCHIVED,
      forkedFrom: { threadId: archivedMaster.id },
    });
    const activeCard = thread("active", "Card: Continuation", {
      projectId: "orchard-worktree",
      forkedFrom: { threadId: archivedParent.id },
    });
    const settledCard = thread("settled", "Card: Settled continuation", {
      shelf: "settled",
      forkedFrom: { threadId: archivedMaster.id },
    });

    const model = workspace([archivedMaster, archivedParent, activeCard, settledCard]);

    expect(model.activeProjects[0]?.masters[0]).toMatchObject({
      master: archivedMaster,
      cards: [activeCard],
    });
    expect(model.activeProjects[0]?.visibleCount).toBe(1);
    expect(model.settledProjects[0]?.masters[0]?.cards).toEqual([settledCard]);
    expect(model.activeProjects.flatMap((group) => group.orphanCards)).toEqual([]);
  });
});

describe("projectWorkSummary", () => {
  it("counts masters, cards and chats in lower case with singular and plural nouns", () => {
    const master = thread("master", "Master: Harvest");
    const card = thread("card", "Card: Prune", { forkedFrom: { threadId: master.id } });
    const chat = thread("chat", "Quick question");
    const orphan = thread("orphan", "Card: Imported");
    const other = thread("other", "Card: Irrigation", { forkedFrom: { threadId: master.id } });

    expect(projectWorkSummary(workspace([master, card]).activeProjects[0]!)).toBe(
      "1 master · 1 card",
    );
    expect(
      projectWorkSummary(workspace([master, card, other, chat, orphan]).activeProjects[0]!),
    ).toBe("1 master · 3 cards · 1 chat");
  });

  it("counts an archived Master's live Cards but not the archived Master", () => {
    const archivedMaster = thread("master", "Master: Archived", { archivedAt: ARCHIVED });
    const card = thread("card", "Card: Continuation", {
      forkedFrom: { threadId: archivedMaster.id },
    });
    const chats = [thread("a", "First question"), thread("b", "Second question")];

    expect(projectWorkSummary(workspace([archivedMaster, card, ...chats]).activeProjects[0]!)).toBe(
      "1 card · 2 chats",
    );
  });
});

describe("collapsible groups", () => {
  // A small workspace: a pinned Master with a Card; orchard with a Master, its
  // Card, a chat and an orphan Card; lighthouse with a Master and an archived
  // Master heading a live Card; a snoozed Card and chat; a settled chat.
  const harvest = thread("harvest", "Master: Harvest", { shelf: "pinned" });
  const prune = thread("prune", "Card: Prune", { forkedFrom: { threadId: "harvest" } });
  const greenhouse = thread("greenhouse", "Master: Greenhouse");
  const heater = thread("heater", "Card: Heater", { forkedFrom: { threadId: "greenhouse" } });
  const soil = thread("soil", "Soil question");
  const compost = thread("compost", "Card: Imported compost");
  const keeper = thread("keeper", "Master: Keeper", { projectId: "lighthouse" });
  const leave = thread("leave", "Card: Leave", {
    projectId: "lighthouse",
    forkedFrom: { threadId: "keeper" },
  });
  const beacon = thread("beacon", "Master: Beacon", {
    projectId: "lighthouse",
    archivedAt: ARCHIVED,
  });
  const lens = thread("lens", "Card: Lens", {
    projectId: "lighthouse",
    forkedFrom: { threadId: "beacon" },
  });
  const vents = thread("vents", "Card: Vents", {
    shelf: "snoozed",
    forkedFrom: { threadId: "greenhouse" },
  });
  const tides = thread("tides", "Tide tables", { projectId: "lighthouse", shelf: "snoozed" });
  const oven = thread("oven", "Oven log", { projectId: "bakery", shelf: "settled" });
  const all = [harvest, prune, greenhouse, heater, soil, compost, keeper, leave, beacon, lens];
  const model = workspace([...all, vents, tides, oven], ["orchard", "lighthouse", "bakery"]);
  const keyOf = (item: TestThread) => `${item.environmentId}:${item.id}`;
  const projects = model.activeProjects.map(disclosureKey.project);
  const groups = [
    ...projects,
    disclosureKey.shelf("snoozed"),
    disclosureKey.shelf("settled"),
    ...["harvest", "greenhouse", "keeper", "beacon"].map((id) =>
      disclosureKey.master(`env-a:${id}`),
    ),
  ];
  const threads = [...all, vents, tides, oven];

  // The sidebar's disclosure, driven exactly as MasterWorkspaceSidebar drives it.
  function sidebar() {
    let disclosure: Disclosure = new Map();
    let active: string | null = null;
    const view = {
      get disclosure() {
        return disclosure;
      },
      get active() {
        return active;
      },
      navigate(target: TestThread) {
        active = keyOf(target);
        disclosure = navigateDisclosure(model, disclosure, keyOf, active) ?? disclosure;
      },
      toggle(key: string) {
        disclosure = setDisclosure(disclosure, [key], !isDisclosureOpen(disclosure, key));
      },
      setProjects(open: boolean) {
        disclosure = setDisclosure(disclosure, projects, open);
      },
      rows: () => visibleWorkspaceRows(model, disclosure, keyOf).map(keyOf),
      shows: (target: TestThread) => view.rows().includes(keyOf(target)),
      open: (key: string) => isDisclosureOpen(disclosure, key),
    };
    return view;
  }
  const orchard = disclosureKey.project({ environmentId: "env-a", projectId: "orchard" });
  const lighthouse = disclosureKey.project({ environmentId: "env-a", projectId: "lighthouse" });

  it("keeps orchard open when a visible pinned row is clicked after a search jump (D1)", () => {
    const view = sidebar();
    view.navigate(heater);
    expect(view.open(orchard)).toBe(true);
    view.navigate(harvest);
    expect(view.open(orchard)).toBe(true);
    expect(view.shows(greenhouse) && view.shows(heater)).toBe(true);
  });

  it("keeps orchard open when a visible row in another project is clicked after a deep link (D3)", () => {
    const view = sidebar();
    view.navigate(greenhouse);
    view.toggle(lighthouse);
    view.navigate(keeper);
    expect(view.open(orchard)).toBe(true);
    expect(view.shows(greenhouse)).toBe(true);
  });

  it("keeps a group reopened by navigation open when a visible row inside is clicked", () => {
    const view = sidebar();
    view.navigate(greenhouse);
    view.toggle(orchard);
    expect(view.shows(greenhouse)).toBe(false);
    view.navigate(heater);
    view.navigate(greenhouse);
    expect(view.shows(greenhouse)).toBe(true);
  });

  it("lets the user collapse the group holding the active thread, and a Master's Cards", () => {
    const view = sidebar();
    view.navigate(greenhouse);
    view.toggle(disclosureKey.master("env-a:greenhouse"));
    expect(view.shows(heater)).toBe(false);
    expect(view.shows(greenhouse)).toBe(true);
    view.toggle(orchard);
    expect(view.shows(greenhouse)).toBe(false);
  });

  it("holds its invariants over random sequences of toggles, navigation and row clicks", () => {
    let seed = 20260924;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let run = 0; run < 300; run += 1) {
      const view = sidebar();
      const userCollapsed = new Set<string>();
      view.navigate(threads[random(threads.length)]!);
      for (let step = 0; step < 30; step += 1) {
        const action = random(6);
        const label = `run ${run} step ${step} action ${action}`;
        if (action === 0) {
          const key = groups[random(groups.length)]!;
          view.toggle(key);
          if (view.open(key)) userCollapsed.delete(key);
          else userCollapsed.add(key);
        } else if (action === 1 || action === 2) {
          view.setProjects(action === 2);
          for (const key of projects) {
            if (action === 2) userCollapsed.delete(key);
            else userCollapsed.add(key);
          }
        } else if (action === 3) {
          // Search or deep link: anywhere, hidden or not.
          const target = threads[random(threads.length)]!;
          const before = view.disclosure;
          view.navigate(target);
          for (const key of groups) {
            if (view.open(key) !== isDisclosureOpen(before, key)) userCollapsed.delete(key);
          }
          expect(view.shows(target), label).toBe(true);
        } else {
          // Click a row already on screen.
          const rows = view.rows();
          const target = threads.find((item) => keyOf(item) === rows[random(rows.length)]);
          if (!target) continue;
          const before = groups.map((key) => view.open(key));
          view.navigate(target);
          expect(
            groups.map((key) => view.open(key)),
            label,
          ).toEqual(before);
          expect(view.shows(target), label).toBe(true);
        }
        for (const key of userCollapsed) expect(view.open(key), `${label} ${key}`).toBe(false);
      }
    }
  });
});

describe("settled shelf", () => {
  it("lists settled threads and archived Masters flat, newest first, keeping live Cards on their shelf", () => {
    const archivedMaster = thread("beacon", "Master: Beacon", {
      projectId: "lighthouse",
      archivedAt: ARCHIVED,
      updatedAt: "2026-09-12T00:00:00.000Z",
    });
    const liveCard = thread("lens", "Card: Lens", {
      projectId: "lighthouse",
      forkedFrom: { threadId: archivedMaster.id },
    });
    const settledChat = thread("oven", "Oven log", {
      projectId: "bakery",
      shelf: "settled",
      updatedAt: "2026-09-14T00:00:00.000Z",
    });
    const settledMaster = thread("done", "Master: Done", {
      shelf: "settled",
      updatedAt: "2026-09-15T00:00:00.000Z",
    });

    const model = workspace([archivedMaster, liveCard, settledChat, settledMaster]);

    expect(model.settled).toEqual([settledMaster, settledChat, archivedMaster]);
    expect(model.activeProjects[0]?.masters[0]).toMatchObject({
      master: archivedMaster,
      cards: [liveCard],
      structural: true,
    });
  });
});

describe("exclusive shelves", () => {
  it("moves a pinned Master and its active Cards to Pinned, so nothing renders twice", () => {
    const master = thread("master", "Master: Harvest", { shelf: "pinned" });
    const card = thread("card", "Card: Prune", { forkedFrom: { threadId: master.id } });
    const snoozedCard = thread("snoozed", "Card: Later", {
      shelf: "snoozed",
      forkedFrom: { threadId: master.id },
    });
    const pinnedCard = thread("pinned-card", "Card: Watch", {
      shelf: "pinned",
      forkedFrom: { threadId: master.id },
    });

    const model = workspace([master, card, snoozedCard, pinnedCard], ["orchard"]);

    expect(model.pinned).toEqual([
      { thread: master, cards: [card] },
      { thread: pinnedCard, cards: [] },
    ]);
    expect(model.activeProjects).toEqual([]);
    // A parked Card stays on its own shelf under an inert structural header,
    // so the pinned Master is navigable exactly once.
    const snoozedGroup = model.snoozedProjects[0];
    expect(snoozedGroup?.masters[0]).toEqual({ master, cards: [snoozedCard], structural: true });
    expect(snoozedGroup ? navigableRows(snoozedGroup) : []).toEqual([snoozedCard]);
  });

  it("never offers an archived Master as a navigable row, only its live Cards", () => {
    const archivedMaster = thread("master", "Master: Archived", { archivedAt: ARCHIVED });
    const card = thread("card", "Card: Still running", {
      forkedFrom: { threadId: archivedMaster.id },
    });
    const chat = thread("chat", "Quick question");

    const group = workspace([archivedMaster, card, chat]).activeProjects[0];

    expect(group?.masters[0]).toMatchObject({ master: archivedMaster, structural: true });
    expect(group ? navigableRows(group) : []).toEqual([card, chat]);
  });
});

describe("nextUnparkedKey", () => {
  it("moves to the next unparked row after parking the open thread, wrapping around", () => {
    const parked = new Set(["b", "d"]);
    const isParked = (key: string) => parked.has(key);

    expect(nextUnparkedKey(["a", "b", "c", "d"], "a", isParked)).toBe("c");
    expect(nextUnparkedKey(["a", "b", "c", "d"], "c", isParked)).toBe("a");
    expect(nextUnparkedKey(["a", "b"], "a", isParked)).toBeNull();
    // Off screen: no guess, the caller starts a new thread instead.
    expect(nextUnparkedKey(["a", "b"], "z", isParked)).toBeNull();
  });
});

describe("sidebar and board agreement", () => {
  it("both place a live Card under its archived Master", () => {
    const archivedMaster = thread("master", "Master: Archived", { archivedAt: ARCHIVED });
    const card = thread("card", "Card: Still running", {
      forkedFrom: { threadId: archivedMaster.id },
    });
    const threads = [archivedMaster, card];

    const sidebarOwner = workspace(threads).activeProjects[0]?.masters[0]?.master;
    const board = deriveMasterBoard(card, threads);

    expect(sidebarOwner).toBe(archivedMaster);
    expect(board?.master).toBe(archivedMaster);
    expect(board?.cards).toEqual([card]);
  });

  it("both resolve a Card living in another project or worktree", () => {
    const master = thread("master", "Master: Harvest", { projectId: "orchard" });
    const card = thread("card", "Card: Elsewhere", {
      projectId: "orchard-worktree",
      forkedFrom: { threadId: master.id },
    });
    const threads = [master, card];

    expect(workspace(threads).activeProjects[0]?.masters[0]?.cards).toEqual([card]);
    expect(deriveMasterBoard(master, threads)?.cards).toEqual([card]);
    expect(deriveMasterBoard(card, threads)?.master).toBe(master);
  });
});

describe("mergeLiveAndArchivedThreads", () => {
  it("lets a live row win over a stale archived record, so unarchiving never hides a Card", () => {
    const master = thread("master", "Master: Harvest");
    const liveCard = thread("card", "Card: Unarchived", { forkedFrom: { threadId: master.id } });
    const staleArchivedCard = { ...liveCard, archivedAt: ARCHIVED };
    const archivedOnly = thread("gone", "Card: Archived", {
      archivedAt: ARCHIVED,
      forkedFrom: { threadId: master.id },
    });

    const merged = mergeLiveAndArchivedThreads(
      [master, liveCard],
      [staleArchivedCard, archivedOnly],
    );

    expect(merged).toEqual([master, liveCard, archivedOnly]);
    expect(deriveMasterBoard(master, merged)?.cards).toEqual([liveCard]);
  });
});

describe("deriveMasterBoard", () => {
  it("recognises Master and Card prefixes without depending on casing or spacing", () => {
    expect(isMasterThreadTitle(" Master: Harvest")).toBe(true);
    expect(isMasterThreadTitle("master : Harvest")).toBe(true);
    expect(isCardThreadTitle("CARD: Prune")).toBe(true);
    expect(isCardThreadTitle("Harvest planning")).toBe(false);
  });

  it("associates cards through direct and nested fork lineage", () => {
    const master = thread("master", "Master: Harvest");
    const direct = thread("direct", "Card: Direct", { forkedFrom: { threadId: master.id } });
    const nested = thread("nested", "Card: Nested", { forkedFrom: { threadId: direct.id } });

    expect(deriveMasterBoard(master, [master, direct, nested])?.cards).toEqual([direct, nested]);
  });

  it("never guesses ownership for unlinked Cards", () => {
    const harvest = thread("harvest", "Master: Harvest");
    const planting = thread("planting", "Master: Planting");
    const linked = thread("linked", "Card: Linked", { forkedFrom: { threadId: harvest.id } });
    const unlinked = thread("unlinked", "Card: Unlinked");

    const board = deriveMasterBoard(harvest, [harvest, planting, linked, unlinked]);

    expect(board?.cards).toEqual([linked]);
    expect(board?.peerMasters).toEqual([planting]);
  });

  it("assigns cards to their nearest Master ancestor", () => {
    const harvest = thread("harvest", "Master: Harvest");
    const planting = thread("planting", "Master: Planting", {
      forkedFrom: { threadId: harvest.id },
    });
    const card = thread("card", "Card: Seed check", { forkedFrom: { threadId: planting.id } });

    expect(deriveMasterBoard(harvest, [harvest, planting, card])?.cards).toEqual([]);
    expect(deriveMasterBoard(planting, [harvest, planting, card])?.cards).toEqual([card]);
  });

  it("excludes archived cards but retains their lineage for a live descendant", () => {
    const master = thread("master", "Master: Harvest");
    const archivedParent = thread("archived-parent", "Card: Archived parent", {
      forkedFrom: { threadId: master.id },
      archivedAt: ARCHIVED,
    });
    const liveChild = thread("live-child", "Card: Live child", {
      forkedFrom: { threadId: archivedParent.id },
    });

    expect(deriveMasterBoard(master, [master, archivedParent, liveChild])?.cards).toEqual([
      liveChild,
    ]);
  });

  it("keeps archived peer Masters hidden while resolving an archived owner", () => {
    const archivedOwner = thread("archived-owner", "Master: Archived owner", {
      archivedAt: ARCHIVED,
    });
    const archivedPeer = thread("archived-peer", "Master: Archived peer", {
      archivedAt: ARCHIVED,
    });
    const livePeer = thread("live-peer", "Master: Live peer");
    const card = thread("card", "Card: Continue", { forkedFrom: { threadId: archivedOwner.id } });

    const board = deriveMasterBoard(card, [archivedOwner, archivedPeer, livePeer, card]);

    expect(board?.master).toBe(archivedOwner);
    expect(board?.peerMasters).toEqual([livePeer]);
  });

  it("ignores broken lineage and cycles, and sorts malformed timestamps consistently", () => {
    const master = thread("master", "Master: Harvest");
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

    expect(deriveMasterBoard(master, [master, broken, cycleA, cycleB, zulu, alpha])?.cards).toEqual(
      [alpha, zulu],
    );
  });

  it("isolates environments", () => {
    const master = thread("master", "Master: Harvest");
    const otherEnvironment = thread("other", "Card: Other environment", {
      environmentId: "env-b",
      forkedFrom: { threadId: master.id },
    });

    expect(deriveMasterBoard(master, [master, otherEnvironment])?.cards).toEqual([]);
  });

  it("returns no board for an ordinary thread", () => {
    const ordinary = thread("ordinary", "Fix the gate");
    expect(deriveMasterBoard(ordinary, [ordinary])).toBeNull();
  });
});
