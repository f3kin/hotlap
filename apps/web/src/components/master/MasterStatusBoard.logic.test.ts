import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import masterWorkspaceSidebarSource from "./MasterWorkspaceSidebar.tsx?raw";

import {
  PERSISTED_STATE_KEY,
  legacyProjectCwdPreferenceKey,
  parsePersistedState,
  persistState,
  projectExpansionPreferenceKeys,
  resolveProjectExpanded,
  setMasterWorkspaceExpanded,
  setProjectExpanded,
  type PersistedUiState,
  type UiState,
} from "../../uiStateStore";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import type { Project } from "../../types";

import {
  collapsedAttention,
  deriveMasterBoard,
  deriveMasterWorkspace,
  isCardThreadTitle,
  isDisclosureOpen,
  masterProjectStoreKeys,
  isMasterThreadTitle,
  mergeLiveAndArchivedThreads,
  navigableRows,
  nextUnparkedKey,
  projectWorkSummary,
  disclosureKey,
  disclosureKeysHolding,
  onNavigate,
  persistedDisclosureWrites,
  readPersistedDisclosure,
  setDisclosure,
  visibleWorkspaceRows,
  type Disclosure,
  type NavigationSource,
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

// Saves with the real persistState into an in-memory localStorage and reads
// the result back with parsePersistedState, as the app does on start.
function reloadThroughStorage(state: UiState): UiState {
  const items = new Map<string, string>();
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
  vi.stubGlobal("window", { localStorage: storage });
  try {
    persistState(state);
  } finally {
    vi.unstubAllGlobals();
  }
  return parsePersistedState(
    JSON.parse(items.get(PERSISTED_STATE_KEY) ?? "{}") as PersistedUiState,
  );
}

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

  // The sidebar's disclosure, driven through the same entry points the
  // component calls: onNavigate for every navigation, setDisclosure for toggles.
  // Each project stored the way the app keys it: a repository group whose
  // grouped key differs from the physical key, one member per group here.
  const groupOfProject = (project: { environmentId: string; id: string }) => ({
    projectKey: `repo:${project.id}`,
    memberProjects: [
      {
        environmentId: project.environmentId,
        id: project.id,
        physicalProjectKey: `physical:${project.id}`,
        workspaceRoot: `/tmp/${project.id}`,
      },
    ],
  });
  const projectStoreKeys = masterProjectStoreKeys(
    ["orchard", "lighthouse", "bakery"].map((id) => ({
      environmentId: "env-a",
      id,
      workspaceRoot: `/tmp/${id}`,
    })),
    ["orchard", "lighthouse", "bakery"].map((id) => groupOfProject({ environmentId: "env-a", id })),
  );
  function sidebar() {
    // The persisted UI store, written and read through the same adapter the
    // component uses; the last reported route lives in memory.
    let store: UiState = parsePersistedState({});
    let route: string | null = null;
    let active: string | null = null;
    const current = () => readPersistedDisclosure(store, projectStoreKeys);
    const write = (next: Disclosure) => {
      for (const change of persistedDisclosureWrites(current(), next, projectStoreKeys)) {
        store =
          change.slot === "project"
            ? setProjectExpanded(store, change.keys, change.open)
            : setMasterWorkspaceExpanded(store, change.keys, change.open);
      }
    };
    const go = (target: string | null, source: NavigationSource) => {
      const next = onNavigate(model, { disclosure: current(), route }, keyOf, target, source);
      if (next === null) return;
      write(next.disclosure);
      route = next.route;
    };
    const view = {
      get disclosure() {
        return current();
      },
      get active() {
        return active;
      },
      // A user navigation (row click, search select, keyboard): openThread
      // calls onNavigate, then the route changes and the router effect runs.
      navigate(target: TestThread, source: NavigationSource = "user") {
        if (source === "user") {
          go(keyOf(target), "user");
          // The render between the click and the router catching up still
          // reports the old route.
          go(active, "route");
        }
        active = keyOf(target);
        go(active, "route");
      },
      // The router effect re-running on an unchanged route (a re-render).
      rerender: () => go(active, "route"),
      // A reload: the real save function writes the store, it is read back
      // the way the app reads it at start, the in-memory route is gone, and
      // the router lands on the same route.
      reload() {
        store = reloadThroughStorage(store);
        route = null;
        go(active, "route");
      },
      get store() {
        return store;
      },
      set store(next: UiState) {
        store = next;
      },
      toggle(key: string) {
        write(setDisclosure(current(), [key], !isDisclosureOpen(current(), key)));
      },
      setProjects(open: boolean) {
        write(setDisclosure(current(), projects, open));
      },
      rows: () => visibleWorkspaceRows(model, current(), keyOf).map(keyOf),
      shows: (target: TestThread) => view.rows().includes(keyOf(target)),
      open: (key: string) => isDisclosureOpen(current(), key),
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

  it("reveals the active thread when the user navigates to it again from search", () => {
    const view = sidebar();
    view.navigate(greenhouse);
    view.toggle(orchard);
    view.rerender();
    expect(view.shows(greenhouse)).toBe(false);
    view.navigate(greenhouse);
    expect(view.shows(greenhouse)).toBe(true);
  });

  it("reveals an active Card hidden by its collapsed Master when the user navigates to it again", () => {
    const view = sidebar();
    view.navigate(heater);
    view.toggle(disclosureKey.master("env-a:greenhouse"));
    view.rerender();
    expect(view.shows(heater)).toBe(false);
    view.navigate(heater);
    expect(view.shows(heater)).toBe(true);
  });

  it("keeps orchard collapsed when a visible row in another project is clicked", () => {
    const view = sidebar();
    view.navigate(greenhouse);
    view.toggle(orchard);
    view.navigate(keeper);
    expect(view.open(orchard)).toBe(false);
    view.navigate(leave);
    expect(view.open(orchard)).toBe(false);
  });

  it("shares project collapse with the legacy sidebar through its grouped key", () => {
    const orchardKeys = projectExpansionPreferenceKeys(
      groupOfProject({ environmentId: "env-a", id: "orchard" }),
    );
    const view = sidebar();
    // The legacy sidebar collapsed orchard under its grouped key only.
    view.store = setProjectExpanded(view.store, [`repo:orchard`], false);
    expect(view.open(orchard)).toBe(false);
    // Reopening it here reaches the legacy sidebar, which reads the grouped key first.
    view.toggle(orchard);
    expect(resolveProjectExpanded(view.store.projectExpandedById, orchardKeys)).toBe(true);
    expect(view.store.projectExpandedById["repo:orchard"]).toBe(true);
  });

  it("reads very old cwd-format project state", () => {
    const view = sidebar();
    view.store = parsePersistedState({ collapsedProjectCwds: ["/tmp/orchard"] });
    expect(view.open(orchard)).toBe(false);
    expect(view.open(lighthouse)).toBe(true);
  });

  it("starts projects and Masters open and the quiet shelves collapsed", () => {
    const view = sidebar();
    expect(view.open(orchard)).toBe(true);
    expect(view.open(disclosureKey.master("env-a:greenhouse"))).toBe(true);
    expect(view.open(disclosureKey.shelf("snoozed"))).toBe(false);
    expect(view.open(disclosureKey.shelf("settled"))).toBe(false);
    expect(view.shows(heater) && view.shows(keeper)).toBe(true);
  });

  it("keeps collapses across a reload, and reveals the active thread after it", () => {
    const view = sidebar();
    view.navigate(keeper);
    view.toggle(orchard);
    view.toggle(disclosureKey.master("env-a:keeper"));
    view.toggle(disclosureKey.shelf("settled"));
    view.reload();
    expect(view.open(orchard)).toBe(false);
    expect(view.open(disclosureKey.master("env-a:keeper"))).toBe(false);
    expect(view.open(disclosureKey.shelf("settled"))).toBe(true);
    expect(view.shows(keeper)).toBe(true);
    view.toggle(lighthouse);
    view.reload();
    expect(view.shows(keeper)).toBe(true);
  });

  it("lets a re-render on the same route keep the user's collapse", () => {
    const view = sidebar();
    view.navigate(greenhouse, "route");
    view.toggle(orchard);
    view.rerender();
    expect(view.open(orchard)).toBe(false);
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
    // mulberry32: a small seeded generator, so a failure replays exactly.
    let seed = 20260924;
    const random = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
    };
    for (let run = 0; run < 300; run += 1) {
      const view = sidebar();
      const userCollapsed = new Set<string>();
      view.navigate(threads[random(threads.length)]!);
      for (let step = 0; step < 30; step += 1) {
        const action = random(9);
        const label = `run ${run} step ${step} action ${action}`;
        // Navigation (a reload included) may reopen only the groups holding the
        // thread it lands on; every other user collapse must survive it.
        const forgetLandedIn = (target: string | null) => {
          if (target === null) return;
          for (const key of disclosureKeysHolding(model, keyOf, target) ?? []) {
            userCollapsed.delete(key);
          }
        };
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
        } else if (action === 3 || action === 4) {
          // Search select (user) or a route change (deep link, back/forward):
          // anywhere, hidden or not. A route to the thread already active is no
          // route change, so the router case picks another thread.
          const target = threads[random(threads.length)]!;
          if (action === 4 && keyOf(target) === view.active) continue;
          view.navigate(target, action === 3 ? "user" : "route");
          forgetLandedIn(keyOf(target));
          expect(view.shows(target), label).toBe(true);
        } else if (action === 5) {
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
        } else if (action === 6) {
          // Search select of the thread that is already active.
          const target = threads.find((item) => keyOf(item) === view.active);
          if (!target) continue;
          view.navigate(target);
          forgetLandedIn(keyOf(target));
          expect(view.shows(target), label).toBe(true);
        } else if (action === 8) {
          // Reload or restart: persisted records come back, the active route lands again.
          view.reload();
          forgetLandedIn(view.active);
          const target = threads.find((item) => keyOf(item) === view.active);
          if (target) expect(view.shows(target), label).toBe(true);
        } else {
          // The router effect re-running on the same route changes nothing.
          const before = groups.map((key) => view.open(key));
          view.rerender();
          expect(
            groups.map((key) => view.open(key)),
            label,
          ).toEqual(before);
        }
        for (const key of userCollapsed) expect(view.open(key), `${label} ${key}`).toBe(false);
      }
    }
  });
});

describe("masterProjectStoreKeys", () => {
  // One repository checked out in two environments: under the default
  // "repository" grouping, one legacy group with two Master project headers.
  const repositoryIdentity = {
    canonicalKey: "github.com/example/orchard",
    locator: {
      source: "git-remote" as const,
      remoteName: "origin",
      remoteUrl: "https://github.com/example/orchard.git",
    },
  };
  const project = (id: string, environmentId: string, workspaceRoot: string): Project => ({
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make(environmentId),
    title: "orchard",
    workspaceRoot,
    repositoryIdentity,
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  });
  const a = project("orchard-a", "env-a", "/srv/a/orchard");
  const b = project("orchard-b", "env-b", "/srv/b/orchard");
  const snapshots = (projects: Project[]) =>
    buildSidebarProjectSnapshots({
      projects,
      settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
      primaryEnvironmentId: EnvironmentId.make("env-a"),
      resolveEnvironmentLabel: () => null,
    });
  const keysFor = (projects: Project[]) => masterProjectStoreKeys(projects, snapshots(projects));
  const keyA = disclosureKey.project({ environmentId: "env-a", projectId: "orchard-a" });
  const keyB = disclosureKey.project({ environmentId: "env-b", projectId: "orchard-b" });
  const apply = (
    state: UiState,
    keys: ReadonlyMap<string, readonly string[]>,
    next: Disclosure,
  ) => {
    for (const change of persistedDisclosureWrites(
      readPersistedDisclosure(state, keys),
      next,
      keys,
    )) {
      state =
        change.slot === "project"
          ? setProjectExpanded(state, change.keys, change.open)
          : setMasterWorkspaceExpanded(state, change.keys, change.open);
    }
    return state;
  };
  const toggle = (
    state: UiState,
    keys: ReadonlyMap<string, readonly string[]>,
    key: string,
    open: boolean,
  ) => apply(state, keys, setDisclosure(readPersistedDisclosure(state, keys), [key], open));
  const openIn = (state: UiState, keys: ReadonlyMap<string, readonly string[]>, key: string) =>
    isDisclosureOpen(readPersistedDisclosure(state, keys), key);
  const legacyOpen = (state: UiState, projects: Project[]) =>
    resolveProjectExpanded(
      state.projectExpandedById,
      projectExpansionPreferenceKeys(snapshots(projects)[0]!),
    );

  it("gives the two members of a real repository group their own keys", () => {
    expect(snapshots([a, b])).toHaveLength(1);
    const keys = keysFor([a, b]);
    expect(keys.get(keyA)).toEqual([
      "env-a:/srv/a/orchard",
      legacyProjectCwdPreferenceKey("/srv/a/orchard"),
    ]);
    expect(keys.get(keyB)).toEqual([
      "env-b:/srv/b/orchard",
      legacyProjectCwdPreferenceKey("/srv/b/orchard"),
    ]);
  });

  it("collapses one member without collapsing its sibling", () => {
    const keys = keysFor([a, b]);
    const state = reloadThroughStorage(toggle(parsePersistedState({}), keys, keyA, false));
    expect(openIn(state, keys, keyA)).toBe(false);
    expect(openIn(state, keys, keyB)).toBe(true);
  });

  it("reveals one member without opening its collapsed sibling", () => {
    const keys = keysFor([a, b]);
    let state = toggle(parsePersistedState({}), keys, keyA, false);
    state = toggle(state, keys, keyB, false);
    state = toggle(state, keys, keyA, true);
    expect(openIn(state, keys, keyA)).toBe(true);
    expect(openIn(state, keys, keyB)).toBe(false);
  });

  it("reads a member's own keys, never the group key, in a multi-member group", () => {
    const keys = keysFor([a, b]);
    const groupKey = snapshots([a, b])[0]!.projectKey;
    const state = setProjectExpanded(parsePersistedState({}), [groupKey], false);
    expect(openIn(state, keys, keyA)).toBe(true);
    expect(openIn(state, keys, keyB)).toBe(true);
  });

  it("keeps a single-member group in the legacy keys and order, group key first", () => {
    const keys = keysFor([a]);
    expect(keys.get(keyA)).toEqual(projectExpansionPreferenceKeys(snapshots([a])[0]!));
    let state = toggle(parsePersistedState({}), keys, keyA, false);
    expect(legacyOpen(state, [a])).toBe(false);
    state = setProjectExpanded(state, projectExpansionPreferenceKeys(snapshots([a])[0]!), true);
    expect(openIn(state, keys, keyA)).toBe(true);
  });

  it("does not collapse a member that joins a group whose sole member was collapsed", () => {
    const state = toggle(parsePersistedState({}), keysFor([a]), keyA, false);
    const joined = keysFor([a, b]);
    expect(openIn(state, joined, keyA)).toBe(false);
    expect(openIn(state, joined, keyB)).toBe(true);
  });

  it("agrees with the legacy sidebar when a group shrinks back to one member", () => {
    const both = [a, b];
    let state = setProjectExpanded(
      parsePersistedState({}),
      projectExpansionPreferenceKeys(snapshots(both)[0]!),
      true,
    );
    state = toggle(state, keysFor(both), keyA, false);
    expect(openIn(state, keysFor([a]), keyA)).toBe(legacyOpen(state, [a]));
  });

  it("is what the Master sidebar builds its store keys with", () => {
    // Wiring guard: the component passes its own projects and project groups
    // to masterProjectStoreKeys, with no key mapping of its own. (It cannot
    // catch the call's result being ignored; that is a documented residue.)
    const source = masterWorkspaceSidebarSource;
    expect(source).toMatch(
      /const projectStoreKeys = useMemo\(\s*\(\) =>\s*masterProjectStoreKeys\(projects, projectGroups\)/,
    );
    expect(source).not.toMatch(/derivePhysicalProjectKey|projectExpansionPreferenceKeys/);
  });
});

describe("collapsedAttention", () => {
  it("rolls up what a group hides only while it is collapsed", () => {
    expect(collapsedAttention(false, ["ready", "failed", "approval"])).toBe("approval");
    expect(collapsedAttention(true, ["ready", "failed", "approval"])).toBeNull();
    expect(collapsedAttention(false, ["ready", "working"])).toBeNull();
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
