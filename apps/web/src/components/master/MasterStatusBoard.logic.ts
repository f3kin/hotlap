export interface MasterBoardThread {
  readonly id: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly forkedFrom?: { readonly threadId: string } | undefined;
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
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
}

function descendsFrom<T extends MasterBoardThread>(
  thread: T,
  ancestorId: string,
  threadById: ReadonlyMap<string, T>,
): boolean {
  const visited = new Set<string>();
  let parentId = thread.forkedFrom?.threadId;

  while (parentId !== undefined && !visited.has(parentId)) {
    if (parentId === ancestorId) return true;
    visited.add(parentId);
    parentId = threadById.get(parentId)?.forkedFrom?.threadId;
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
  const hasSingleMaster = masters.length === 1;

  const cards = projectThreads
    .filter((thread) => {
      if (!isCardThreadTitle(thread.title)) return false;
      if (descendsFrom(thread, activeThread.id, threadById)) return true;
      return hasSingleMaster && thread.forkedFrom === undefined;
    })
    .sort(newestFirst);

  return {
    master: activeThread,
    cards,
    peerMasters: masters.filter((thread) => thread.id !== activeThread.id).sort(newestFirst),
  };
}
