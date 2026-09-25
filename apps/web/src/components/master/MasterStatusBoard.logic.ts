import {
  mostUrgentAttentionStatus,
  type SidebarAttentionStatus,
  type SidebarThreadStatus,
} from "../Sidebar.logic";
import { derivePhysicalProjectKeyFromPath } from "../../logicalProject";
import { projectExpansionPreferenceKeys, resolveProjectExpanded } from "../../uiStateStore";

export interface MasterBoardThread {
  readonly id: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly forkedFrom?: { readonly threadId: string } | undefined;
  readonly archivedAt?: string | null | undefined;
}

export interface MasterBoardModel<T extends MasterBoardThread> {
  readonly master: T;
  readonly cards: readonly T[];
  readonly peerMasters: readonly T[];
}

/**
 * Which sidebar shelf a live thread sits on. Shelves are exclusive, as in the
 * default sidebar: a thread renders in exactly one place.
 */
export type MasterShelf = "pinned" | "active" | "snoozed" | "settled";

/** A pinned thread; a pinned Master carries its active Cards with it. */
export interface MasterPinnedEntry<T extends MasterBoardThread> {
  readonly thread: T;
  readonly cards: readonly T[];
}

/**
 * A Master and its Cards on one shelf. `structural` means the Master itself
 * lives elsewhere (another shelf, or archived) and only heads its Cards here:
 * render it as an inert heading, never as a second navigable copy.
 */
export interface MasterShelfBoard<T extends MasterBoardThread> {
  readonly master: T;
  readonly cards: readonly T[];
  readonly structural: boolean;
}

export interface MasterWorkspaceProject<T extends MasterBoardThread> {
  readonly environmentId: string;
  readonly projectId: string;
  readonly masters: readonly MasterShelfBoard<T>[];
  readonly oneOffs: readonly T[];
  readonly orphanCards: readonly T[];
  readonly visibleCount: number;
}

export interface MasterWorkspaceModel<T extends MasterBoardThread> {
  readonly pinned: readonly MasterPinnedEntry<T>[];
  readonly activeProjects: readonly MasterWorkspaceProject<T>[];
  readonly snoozedProjects: readonly MasterWorkspaceProject<T>[];
  readonly settledProjects: readonly MasterWorkspaceProject<T>[];
  /**
   * The Settled shelf as one flat list, newest first, the way the default
   * sidebar's Settled shelf lists its rows: every settled thread plus each
   * archived Master that still heads live Cards (those Cards stay on their
   * shelf under the Master's heading).
   */
  readonly settled: readonly T[];
}

const MASTER_TITLE = /^master\s*:/i;
const CARD_TITLE = /^card\s*:/i;

export function isMasterThreadTitle(title: string): boolean {
  return MASTER_TITLE.test(title.trim());
}

export function isCardThreadTitle(title: string): boolean {
  return CARD_TITLE.test(title.trim());
}

function threadKey(thread: { readonly environmentId: string; readonly id: string }): string {
  return `${thread.environmentId}:${thread.id}`;
}

function newestFirst<T extends MasterBoardThread>(left: T, right: T): number {
  const leftTime = Date.parse(left.updatedAt);
  const rightTime = Date.parse(right.updatedAt);
  const difference =
    (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
  return difference === 0 ? left.id.localeCompare(right.id) : difference;
}

/**
 * Live shells plus archived records, one row per thread. The live stream is
 * authoritative: an archived snapshot can be stale (a thread unarchived on
 * another device), so it only fills in threads the live stream lacks.
 */
export function mergeLiveAndArchivedThreads<T extends MasterBoardThread>(
  live: readonly T[],
  archived: readonly T[],
): readonly T[] {
  if (archived.length === 0) return live;
  const liveKeys = new Set(live.map(threadKey));
  const merged = [...live];
  for (const thread of archived) {
    if (!liveKeys.has(threadKey(thread))) merged.push(thread);
  }
  return merged;
}

/**
 * Card -> owning Master, keyed by scoped thread key. The nearest Master in a
 * Card's fork chain owns it. Lineage is resolved across the whole environment
 * (a Card often lives in another project/worktree than its Master) and walks
 * archived records too, since lineage is durable data, not a visibility
 * concern. Both the sidebar and the board read ownership from here.
 */
export function resolveCardOwners<T extends MasterBoardThread>(
  threads: readonly T[],
): ReadonlyMap<string, T> {
  const byKey = new Map(threads.map((thread) => [threadKey(thread), thread]));
  const owners = new Map<string, T>();
  for (const card of threads) {
    if (!isCardThreadTitle(card.title)) continue;
    const visited = new Set<string>();
    let parentId = card.forkedFrom?.threadId;
    while (parentId !== undefined && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byKey.get(`${card.environmentId}:${parentId}`);
      if (parent !== undefined && isMasterThreadTitle(parent.title)) {
        owners.set(threadKey(card), parent);
        break;
      }
      parentId = parent?.forkedFrom?.threadId;
    }
  }
  return owners;
}

/**
 * Projects the sidebar. Only projects with threads on a shelf get a row.
 * Pinned, snoozed and settled threads move to their own shelves. A pinned
 * Master takes its active Cards into the Pinned shelf; on the other shelves,
 * a Master owning Cards there (or an archived one) appears as a structural
 * header.
 */
export function deriveMasterWorkspace<T extends MasterBoardThread>(input: {
  readonly threads: readonly T[];
  readonly projects: ReadonlyArray<{ readonly environmentId: string; readonly id: string }>;
  readonly shelfOf: (thread: T) => MasterShelf;
}): MasterWorkspaceModel<T> {
  const owners = resolveCardOwners(input.threads);
  const live = input.threads.filter((thread) => thread.archivedAt == null);
  const shelfByKey = new Map(live.map((thread) => [threadKey(thread), input.shelfOf(thread)]));
  const projectOrder = new Map(
    input.projects.map((project, index) => [`${project.environmentId}:${project.id}`, index]),
  );
  const orderOf = (row: { environmentId: string; projectId: string }) =>
    projectOrder.get(`${row.environmentId}:${row.projectId}`) ?? Number.MAX_SAFE_INTEGER;
  const pinnedCards = new Map<string, T[]>();
  const pinned = live
    .filter((thread) => shelfByKey.get(threadKey(thread)) === "pinned")
    .map((thread) => {
      const cards: T[] = [];
      if (isMasterThreadTitle(thread.title)) pinnedCards.set(threadKey(thread), cards);
      return { thread, cards };
    });

  const build = (shelf: MasterShelf): readonly MasterWorkspaceProject<T>[] => {
    const rows = new Map<
      string,
      { environmentId: string; projectId: string; masters: T[]; oneOffs: T[]; orphanCards: T[] }
    >();
    const bucket = (environmentId: string, projectId: string) => {
      const key = `${environmentId}:${projectId}`;
      let entry = rows.get(key);
      if (!entry) {
        entry = { environmentId, projectId, masters: [], oneOffs: [], orphanCards: [] };
        rows.set(key, entry);
      }
      return entry;
    };
    const members = live.filter((thread) => shelfByKey.get(threadKey(thread)) === shelf);
    const memberKeys = new Set(members.map(threadKey));
    const cardsByOwner = new Map<string, T[]>();
    const mastersByKey = new Map<string, T>();
    for (const thread of members) {
      if (isMasterThreadTitle(thread.title)) {
        mastersByKey.set(threadKey(thread), thread);
      } else if (isCardThreadTitle(thread.title)) {
        const owner = owners.get(threadKey(thread));
        if (!owner) {
          bucket(thread.environmentId, thread.projectId).orphanCards.push(thread);
          continue;
        }
        const pinnedOwnerCards = shelf === "active" ? pinnedCards.get(threadKey(owner)) : undefined;
        if (pinnedOwnerCards) {
          pinnedOwnerCards.push(thread);
          continue;
        }
        mastersByKey.set(threadKey(owner), owner);
        const cards = cardsByOwner.get(threadKey(owner)) ?? [];
        cards.push(thread);
        cardsByOwner.set(threadKey(owner), cards);
      } else {
        bucket(thread.environmentId, thread.projectId).oneOffs.push(thread);
      }
    }
    for (const master of mastersByKey.values()) {
      bucket(master.environmentId, master.projectId).masters.push(master);
    }
    return [...rows.values()]
      .sort((left, right) => orderOf(left) - orderOf(right))
      .map((row) => ({
        environmentId: row.environmentId,
        projectId: row.projectId,
        masters: row.masters.sort(newestFirst).map((master) => ({
          master,
          cards: (cardsByOwner.get(threadKey(master)) ?? []).sort(newestFirst),
          structural: !memberKeys.has(threadKey(master)),
        })),
        oneOffs: row.oneOffs.sort(newestFirst),
        orphanCards: row.orphanCards.sort(newestFirst),
        // Structural Master headers (owned elsewhere or archived) don't count.
        visibleCount:
          row.masters.filter((master) => memberKeys.has(threadKey(master))).length +
          row.masters.reduce(
            (count, master) => count + (cardsByOwner.get(threadKey(master))?.length ?? 0),
            0,
          ) +
          row.oneOffs.length +
          row.orphanCards.length,
      }));
  };

  const activeProjects = build("active");
  const snoozedProjects = build("snoozed");
  const settledProjects = build("settled");
  for (const cards of pinnedCards.values()) cards.sort(newestFirst);
  const archivedMasters = new Map<string, T>();
  for (const group of [...activeProjects, ...snoozedProjects, ...settledProjects]) {
    for (const board of group.masters) {
      if (board.master.archivedAt != null) {
        archivedMasters.set(threadKey(board.master), board.master);
      }
    }
  }
  return {
    pinned,
    activeProjects,
    snoozedProjects,
    settledProjects,
    settled: [...settledProjects.flatMap(navigableRows), ...archivedMasters.values()].sort(
      newestFirst,
    ),
  };
}

/**
 * Which collapsible groups are open: projects, the Snoozed and Settled
 * shelves, and each Master's Cards. Disclosure is a pure lookup of explicit
 * records with one default that ignores navigation: projects and Masters
 * start open, the quiet Snoozed and Settled shelves start collapsed. Nothing derives openness from the
 * active thread at render time. Only two things write records:
 * - the user's toggles (one group, or every project at once), and
 * - navigation (initial load, search, deep link, a row click), which writes
 *   "open" for the groups holding the landing thread.
 * So clicking a row already on screen writes "open" to groups that are
 * already open and changes nothing, and a collapse stays until the user
 * reopens the group or navigation lands inside it.
 */
export type Disclosure = ReadonlyMap<string, boolean>;

export const disclosureKey = {
  project: (group: { environmentId: string; projectId: string }) =>
    `project:${group.environmentId}:${group.projectId}`,
  master: (masterKey: string) => `master:${masterKey}`,
  shelf: (shelf: "snoozed" | "settled") => `shelf:${shelf}`,
};

export function isDisclosureOpen(disclosure: Disclosure, key: string): boolean {
  return disclosure.get(key) ?? !key.startsWith("shelf:");
}

/**
 * Disclosure as the UI store persists it across reloads. A project lives in
 * `projectExpandedById` under the legacy sidebar's preference keys
 * (`projectExpansionPreferenceKeys`, read with `resolveProjectExpanded`); a
 * Master's Cards and the shelves live under their disclosure key in
 * `masterWorkspaceExpandedById`.
 */
export interface PersistedDisclosure {
  readonly projectExpandedById: Readonly<Record<string, boolean>>;
  readonly masterWorkspaceExpandedById: Readonly<Record<string, boolean>>;
}

interface PreferenceGroup {
  readonly projectKey: string;
  readonly memberProjects: ReadonlyArray<{
    readonly environmentId: string;
    readonly id: string;
    readonly physicalProjectKey: string;
    readonly workspaceRoot: string;
  }>;
}

/**
 * The store keys each Master project header reads and writes, keyed by its
 * disclosure key, built from the sidebar's own project groups
 * (`buildSidebarProjectSnapshots`). The Master sidebar draws one header per
 * physical project; the legacy sidebar draws one per repository group.
 * - A single-member group is the same header in both sidebars, so it uses
 *   exactly the legacy keys in the legacy order,
 *   `projectExpansionPreferenceKeys(group)`, group key first.
 * - A member of a multi-member group uses only its own physical and cwd
 *   keys, with no group-key fallback, so its siblings stay independent and a
 *   member joining or leaving the group never inherits or loses a choice
 *   through the shared key. (The legacy sidebar writes every member's own
 *   keys whenever it toggles a group, so a fallback would only ever serve
 *   group-only state.)
 * - A project in no group uses its own keys.
 */
export function masterProjectStoreKeys(
  projects: ReadonlyArray<{
    readonly environmentId: string;
    readonly id: string;
    readonly workspaceRoot: string;
  }>,
  projectGroups: readonly PreferenceGroup[],
): ReadonlyMap<string, readonly string[]> {
  const groupByMember = new Map<string, PreferenceGroup>();
  for (const group of projectGroups) {
    for (const member of group.memberProjects) {
      groupByMember.set(`${member.environmentId}:${member.id}`, group);
    }
  }
  const keys = new Map<string, readonly string[]>();
  for (const project of projects) {
    const group = groupByMember.get(`${project.environmentId}:${project.id}`);
    const member = group?.memberProjects.find(
      (candidate) =>
        candidate.environmentId === project.environmentId && candidate.id === project.id,
    ) ?? {
      physicalProjectKey: derivePhysicalProjectKeyFromPath(
        project.environmentId,
        project.workspaceRoot,
      ),
      workspaceRoot: project.workspaceRoot,
    };
    const ownKeys = projectExpansionPreferenceKeys({
      projectKey: member.physicalProjectKey,
      memberProjects: [member],
    }).slice(1);
    keys.set(
      disclosureKey.project({ environmentId: project.environmentId, projectId: project.id }),
      group !== undefined && group.memberProjects.length === 1
        ? projectExpansionPreferenceKeys(group)
        : ownKeys,
    );
  }
  return keys;
}

export function readPersistedDisclosure(
  persisted: PersistedDisclosure,
  projectStoreKeys: ReadonlyMap<string, readonly string[]>,
): Disclosure {
  const disclosure = new Map<string, boolean>();
  for (const [key, open] of Object.entries(persisted.masterWorkspaceExpandedById)) {
    if (!key.startsWith("project:")) disclosure.set(key, open);
  }
  for (const [key, preferenceKeys] of projectStoreKeys) {
    disclosure.set(key, resolveProjectExpanded(persisted.projectExpandedById, preferenceKeys));
  }
  return disclosure;
}

/** The store writes that turn `before` into `after`, in the layout above. */
export function persistedDisclosureWrites(
  before: Disclosure,
  after: Disclosure,
  projectStoreKeys: ReadonlyMap<string, readonly string[]>,
): Array<{
  readonly slot: "project" | "masterWorkspace";
  readonly keys: readonly string[];
  readonly open: boolean;
}> {
  const writes: Array<{
    slot: "project" | "masterWorkspace";
    keys: readonly string[];
    open: boolean;
  }> = [];
  for (const [key, open] of after) {
    if (before.get(key) === open) continue;
    if (key.startsWith("project:")) {
      const preferenceKeys = projectStoreKeys.get(key);
      if (preferenceKeys !== undefined)
        writes.push({ slot: "project", keys: preferenceKeys, open });
    } else {
      writes.push({ slot: "masterWorkspace", keys: [key], open });
    }
  }
  return writes;
}

/**
 * What a collapsible group's header rolls up: the most urgent status among
 * the rows it hides, only while it is collapsed (open, the rows show it).
 */
export function collapsedAttention(
  open: boolean,
  statuses: Iterable<SidebarThreadStatus>,
): SidebarAttentionStatus | null {
  return open ? null : mostUrgentAttentionStatus(statuses);
}

/** Records the same choice for several groups (a toggle, or collapse/expand all). */
export function setDisclosure(
  disclosure: Disclosure,
  keys: readonly string[],
  open: boolean,
): Disclosure {
  if (keys.every((key) => isDisclosureOpen(disclosure, key) === open && disclosure.has(key))) {
    return disclosure;
  }
  const updated = new Map(disclosure);
  for (const key of keys) updated.set(key, open);
  return updated;
}

/**
 * The groups that must be open for a thread to be on screen: its project (or
 * shelf) and the Master heading its Cards. Pinned rows need only their
 * Master. Empty when the thread is not in the workspace.
 */
export function disclosureKeysHolding<T extends MasterBoardThread>(
  model: MasterWorkspaceModel<T>,
  threadKeyOf: (thread: T) => string,
  key: string,
): string[] | null {
  const is = (thread: T) => threadKeyOf(thread) === key;
  const boards = (groups: readonly MasterWorkspaceProject<T>[]) =>
    groups.flatMap((group) => group.masters);
  const masterHolding = (candidates: readonly { master: T; cards: readonly T[] }[]) =>
    candidates
      .filter((board) => board.cards.some(is))
      .map((board) => disclosureKey.master(threadKeyOf(board.master)));
  for (const entry of model.pinned) {
    if (is(entry.thread) || entry.cards.some(is)) {
      return masterHolding([{ master: entry.thread, cards: entry.cards }]);
    }
  }
  for (const group of model.activeProjects) {
    if (navigableRows(group).some(is)) {
      return [disclosureKey.project(group), ...masterHolding(group.masters)];
    }
  }
  for (const group of model.snoozedProjects) {
    if (navigableRows(group).some(is)) {
      return [disclosureKey.shelf("snoozed"), ...masterHolding(boards([group]))];
    }
  }
  if (model.settled.some(is)) return [disclosureKey.shelf("settled")];
  return null;
}

/**
 * The sidebar's disclosure records plus the route the router last reported
 * and acted on. The route is tracked on its own, apart from user navigation:
 * between a click and the router catching up there is a render that still
 * reports the old route, and it must not count as landing there again.
 */
export interface DisclosureState {
  readonly disclosure: Disclosure;
  readonly route: string | null;
}

/**
 * Where the navigation came from. "user" is an explicit request (a row click,
 * search select, keyboard next/previous or jump); "route" is the router
 * reporting the current route (initial load, deep link, back/forward, a
 * reload, or a re-render with the same route).
 */
export type NavigationSource = "user" | "route";

/**
 * The one navigation entry point, for every UI path and for the tests. A
 * navigation writes "open" for the groups holding the landing thread. An
 * explicit user navigation always does, even to the thread that is already
 * active (so searching for it reveals it). The router acts only on a route
 * other than the one it last reported, so a re-render, or the render between
 * a click and the route change, never reopens what the user collapsed. Null
 * while a routed thread is not in the workspace yet: the caller keeps its
 * state and the router retries once the thread arrives.
 */
export function onNavigate<T extends MasterBoardThread>(
  model: MasterWorkspaceModel<T>,
  state: DisclosureState,
  threadKeyOf: (thread: T) => string,
  target: string | null,
  source: NavigationSource,
): DisclosureState | null {
  if (source === "route" && target === state.route) return state;
  const holding = target === null ? [] : disclosureKeysHolding(model, threadKeyOf, target);
  if (holding === null) return source === "route" ? null : state;
  const disclosure = setDisclosure(state.disclosure, holding, true);
  const route = source === "route" ? target : state.route;
  return disclosure === state.disclosure && route === state.route ? state : { disclosure, route };
}

/**
 * The rows on screen, in order, under the given disclosure. `keep` (the
 * active thread) is listed at its position even while a collapsed group
 * hides it, so next/previous thread still moves from it.
 */
export function visibleWorkspaceRows<T extends MasterBoardThread>(
  model: MasterWorkspaceModel<T>,
  disclosure: Disclosure,
  threadKeyOf: (thread: T) => string,
  options: {
    readonly keep?: string | null;
    readonly shows?: (group: { environmentId: string; projectId: string }) => boolean;
  } = {},
): T[] {
  const rows: T[] = [];
  const add = (thread: T, open: boolean) => {
    if (open || threadKeyOf(thread) === options.keep) rows.push(thread);
  };
  const shows = options.shows ?? (() => true);
  const group = (project: MasterWorkspaceProject<T>, open: boolean) => {
    for (const board of project.masters) {
      if (!board.structural) add(board.master, open);
      const cardsOpen =
        open && isDisclosureOpen(disclosure, disclosureKey.master(threadKeyOf(board.master)));
      for (const card of board.cards) add(card, cardsOpen);
    }
    for (const thread of [...project.oneOffs, ...project.orphanCards]) add(thread, open);
  };
  for (const entry of model.pinned) {
    add(entry.thread, true);
    const open = isDisclosureOpen(disclosure, disclosureKey.master(threadKeyOf(entry.thread)));
    for (const card of entry.cards) add(card, open);
  }
  for (const project of model.activeProjects) {
    if (shows(project))
      group(project, isDisclosureOpen(disclosure, disclosureKey.project(project)));
  }
  const snoozedOpen = isDisclosureOpen(disclosure, disclosureKey.shelf("snoozed"));
  for (const project of model.snoozedProjects) if (shows(project)) group(project, snoozedOpen);
  const settledOpen = isDisclosureOpen(disclosure, disclosureKey.shelf("settled"));
  for (const thread of model.settled) if (shows(thread)) add(thread, settledOpen);
  return rows;
}

/**
 * A project group's rows in render order, minus structural Master headings,
 * so every navigable thread appears exactly once across shelves. Drives
 * mod+1..9 and next/previous thread.
 */
export function navigableRows<T extends MasterBoardThread>(group: MasterWorkspaceProject<T>): T[] {
  return [
    ...group.masters.flatMap((board) =>
      board.structural ? [...board.cards] : [board.master, ...board.cards],
    ),
    ...group.oneOffs,
    ...group.orphanCards,
  ];
}

function countOf(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

/**
 * The muted count beside a project header, e.g. "1 master · 3 cards · 1 chat".
 * A structural Master (archived, or living on another shelf) is not counted,
 * but its Cards are; orphan Cards count as cards, since their own heading
 * already sets them apart.
 */
export function projectWorkSummary<T extends MasterBoardThread>(
  group: MasterWorkspaceProject<T>,
): string {
  const masters = group.masters.filter((board) => !board.structural).length;
  const cards =
    group.masters.reduce((total, board) => total + board.cards.length, 0) +
    group.orphanCards.length;
  const parts = [
    masters ? countOf(masters, "master") : null,
    cards ? countOf(cards, "card") : null,
    group.oneOffs.length ? countOf(group.oneOffs.length, "chat") : null,
  ].filter((part) => part !== null);
  return parts.length ? parts.join(" · ") : "No threads";
}

/**
 * Where to go after parking (settling or snoozing) the open thread: the next
 * row after it, wrapping around, that isn't parked. Null when the thread isn't
 * on screen or nothing else qualifies; callers then start a new thread.
 */
export function nextUnparkedKey(
  orderedKeys: readonly string[],
  currentKey: string,
  isParked: (key: string) => boolean,
): string | null {
  const index = orderedKeys.indexOf(currentKey);
  if (index === -1) return null;
  return (
    [...orderedKeys.slice(index + 1), ...orderedKeys.slice(0, index)].find(
      (key) => !isParked(key),
    ) ?? null
  );
}

/**
 * The board for a Master, or for a Card's owning Master. `threads` must carry
 * the same environment-wide, archive-aware lineage the sidebar uses, so the
 * two always agree about who owns a Card.
 */
export function deriveMasterBoard<T extends MasterBoardThread>(
  activeThread: T,
  threads: readonly T[],
): MasterBoardModel<T> | null {
  const environmentThreads = threads.filter(
    (thread) => thread.environmentId === activeThread.environmentId,
  );
  const owners = resolveCardOwners(environmentThreads);
  const master = isMasterThreadTitle(activeThread.title)
    ? activeThread
    : isCardThreadTitle(activeThread.title)
      ? (owners.get(threadKey(activeThread)) ?? null)
      : null;
  if (master === null) return null;

  return {
    master,
    cards: environmentThreads
      .filter(
        (thread) => thread.archivedAt == null && owners.get(threadKey(thread))?.id === master.id,
      )
      .sort(newestFirst),
    // Archived Masters may own active Cards, but must not reappear as
    // navigable peer work.
    peerMasters: environmentThreads
      .filter(
        (thread) =>
          thread.id !== master.id &&
          thread.projectId === master.projectId &&
          thread.archivedAt == null &&
          isMasterThreadTitle(thread.title),
      )
      .sort(newestFirst),
  };
}
