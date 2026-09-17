export interface MasterBoardThread {
  readonly id: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly forkedFrom?: { readonly threadId: string } | undefined;
  readonly archivedAt?: string | null | undefined;
  readonly settledOverride?: "settled" | "active" | null | undefined;
}

export interface MasterBoardModel<T extends MasterBoardThread> {
  readonly master: T;
  readonly cards: readonly T[];
  readonly peerMasters: readonly T[];
}

export interface MasterWorkspaceProject<T extends MasterBoardThread> {
  readonly environmentId: string;
  readonly projectId: string;
  readonly masters: readonly MasterBoardModel<T>[];
  readonly oneOffs: readonly T[];
  readonly orphanCards: readonly T[];
  readonly visibleCount: number;
}

export interface MasterWorkspaceModel<T extends MasterBoardThread> {
  readonly activeProjects: readonly MasterWorkspaceProject<T>[];
  readonly settledProjects: readonly MasterWorkspaceProject<T>[];
}

const MASTER_TITLE = /^master\s*:/i;
const CARD_TITLE = /^card\s*:/i;

export function isMasterThreadTitle(title: string): boolean {
  return MASTER_TITLE.test(title.trim());
}

export function isCardThreadTitle(title: string): boolean {
  return CARD_TITLE.test(title.trim());
}

function newestFirst<T extends MasterBoardThread>(left: T, right: T): number {
  const leftTime = Date.parse(left.updatedAt);
  const rightTime = Date.parse(right.updatedAt);
  const difference =
    (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
  return difference === 0 ? left.id.localeCompare(right.id) : difference;
}

function belongsToMaster<T extends MasterBoardThread>(
  thread: T,
  ancestorId: string,
  threadById: ReadonlyMap<string, T>,
): boolean {
  const visited = new Set<string>();
  let parentId = thread.forkedFrom?.threadId;

  while (parentId !== undefined && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = threadById.get(parentId);
    if (parent !== undefined && isMasterThreadTitle(parent.title)) return parent.id === ancestorId;
    parentId = parent?.forkedFrom?.threadId;
  }

  return false;
}

function ownerByCardId<T extends MasterBoardThread>(threads: readonly T[]): ReadonlyMap<string, T> {
  const byScopedId = new Map(
    threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread]),
  );
  const owners = new Map<string, T>();
  for (const card of threads) {
    if (!isCardThreadTitle(card.title)) continue;
    const visited = new Set<string>();
    let parentId = card.forkedFrom?.threadId;
    while (parentId !== undefined && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byScopedId.get(`${card.environmentId}:${parentId}`);
      if (parent !== undefined && isMasterThreadTitle(parent.title)) {
        owners.set(`${card.environmentId}:${card.id}`, parent);
        break;
      }
      parentId = parent?.forkedFrom?.threadId;
    }
  }
  return owners;
}

/**
 * Projects the sidebar from persisted fork lineage. A Card can live in a
 * different worktree/project from its Master, so ownership is resolved across
 * an environment before rows are assigned to a project bucket.
 */
export function deriveMasterWorkspace<T extends MasterBoardThread>(
  threads: readonly T[],
): MasterWorkspaceModel<T> {
  const visible = threads.filter((thread) => thread.archivedAt == null);
  // Retain archived records here: an active imported Card can have an
  // archived intermediate parent or owner, and lineage is durable data rather
  // than a visibility concern.
  const owners = ownerByCardId(threads);
  const build = (settled: boolean): readonly MasterWorkspaceProject<T>[] => {
    const selected = visible.filter((thread) => (thread.settledOverride === "settled") === settled);
    const projectRows = new Map<
      string,
      { environmentId: string; projectId: string; masters: T[]; oneOffs: T[]; orphanCards: T[] }
    >();
    const bucket = (environmentId: string, projectId: string) => {
      const key = `${environmentId}:${projectId}`;
      let entry = projectRows.get(key);
      if (!entry) {
        entry = { environmentId, projectId, masters: [], oneOffs: [], orphanCards: [] };
        projectRows.set(key, entry);
      }
      return entry;
    };
    const cardsByOwner = new Map<string, T[]>();
    const ownerByKey = new Map<string, T>();
    for (const thread of selected) {
      if (isMasterThreadTitle(thread.title)) continue;
      if (isCardThreadTitle(thread.title)) {
        const owner = owners.get(`${thread.environmentId}:${thread.id}`);
        if (!owner) {
          bucket(thread.environmentId, thread.projectId).orphanCards.push(thread);
          continue;
        }
        const ownerKey = `${owner.environmentId}:${owner.id}`;
        ownerByKey.set(ownerKey, owner);
        const cards = cardsByOwner.get(ownerKey) ?? [];
        cards.push(thread);
        cardsByOwner.set(ownerKey, cards);
      } else {
        bucket(thread.environmentId, thread.projectId).oneOffs.push(thread);
      }
    }
    // Masters in this shelf plus structural Masters that own Cards in this
    // shelf. The latter prevents mixed-lifecycle work from losing ownership;
    // visibleCount below keeps structural headers out of the shelf count.
    for (const master of selected.filter((thread) => isMasterThreadTitle(thread.title))) {
      ownerByKey.set(`${master.environmentId}:${master.id}`, master);
    }
    for (const [, master] of ownerByKey) {
      if (!isMasterThreadTitle(master.title)) continue;
      bucket(master.environmentId, master.projectId).masters.push(master);
    }
    return [...projectRows.entries()]
      .map(([, rows]) => {
        return {
          environmentId: rows.environmentId,
          projectId: rows.projectId,
          masters: rows.masters.sort(newestFirst).map((master) => ({
            master,
            cards: (cardsByOwner.get(`${master.environmentId}:${master.id}`) ?? []).sort(
              newestFirst,
            ),
            peerMasters: [],
          })),
          oneOffs: rows.oneOffs.sort(newestFirst),
          orphanCards: rows.orphanCards.sort(newestFirst),
          visibleCount:
            rows.masters.filter((master) =>
              selected.some(
                (thread) =>
                  thread.environmentId === master.environmentId && thread.id === master.id,
              ),
            ).length +
            rows.masters.reduce(
              (count, master) =>
                count + (cardsByOwner.get(`${master.environmentId}:${master.id}`)?.length ?? 0),
              0,
            ) +
            rows.oneOffs.length +
            rows.orphanCards.length,
        };
      })
      .sort((left, right) =>
        `${left.environmentId}:${left.projectId}`.localeCompare(
          `${right.environmentId}:${right.projectId}`,
        ),
      );
  };
  return { activeProjects: build(false), settledProjects: build(true) };
}

export function deriveMasterBoard<T extends MasterBoardThread>(
  activeThread: T,
  allThreads: readonly T[],
): MasterBoardModel<T> | null {
  const projectThreads = allThreads.filter(
    (thread) =>
      thread.environmentId === activeThread.environmentId &&
      thread.projectId === activeThread.projectId,
  );
  const masters = projectThreads.filter((thread) => isMasterThreadTitle(thread.title));
  const threadById = new Map(projectThreads.map((thread) => [thread.id, thread]));
  let master = isMasterThreadTitle(activeThread.title) ? activeThread : null;
  if (master === null && isCardThreadTitle(activeThread.title)) {
    const visited = new Set<string>();
    let parentId = activeThread.forkedFrom?.threadId;
    while (parentId !== undefined && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = threadById.get(parentId);
      if (parent !== undefined && isMasterThreadTitle(parent.title)) {
        master = parent;
        break;
      }
      parentId = parent?.forkedFrom?.threadId;
    }
  }
  if (master === null) return null;
  const cards = projectThreads
    .filter(
      (thread) =>
        thread.archivedAt == null &&
        isCardThreadTitle(thread.title) &&
        belongsToMaster(thread, master.id, threadById),
    )
    .sort(newestFirst);

  return {
    master,
    cards,
    // Archived Masters may be needed to resolve the owner of an active Card,
    // but they must not reappear as navigable peer work.
    peerMasters: masters
      .filter((thread) => thread.id !== master.id && thread.archivedAt == null)
      .sort(newestFirst),
  };
}
