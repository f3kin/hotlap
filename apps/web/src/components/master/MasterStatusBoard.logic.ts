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

export function deriveMasterBoard<T extends MasterBoardThread>(
  activeThread: T,
  allThreads: readonly T[],
): MasterBoardModel<T> | null {
  if (!isMasterThreadTitle(activeThread.title)) return null;

  const projectThreads = allThreads.filter(
    (thread) =>
      thread.environmentId === activeThread.environmentId &&
      thread.projectId === activeThread.projectId,
  );
  const masters = projectThreads.filter((thread) => isMasterThreadTitle(thread.title));
  const threadById = new Map(projectThreads.map((thread) => [thread.id, thread]));
  const cards = projectThreads
    .filter(
      (thread) =>
        thread.archivedAt == null &&
        isCardThreadTitle(thread.title) &&
        belongsToMaster(thread, activeThread.id, threadById),
    )
    .sort(newestFirst);

  return {
    master: activeThread,
    cards,
    peerMasters: masters.filter((thread) => thread.id !== activeThread.id).sort(newestFirst),
  };
}
