import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ChevronDownIcon, PinIcon } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useNavigate, useParams } from "@tanstack/react-router";

import { cn } from "~/lib/utils";
import { isElectron } from "~/env";
import { openCommandPalette } from "~/commandPaletteBus";
import { useProjects, useThreadShells } from "~/state/entities";
import { buildThreadRouteParams, resolveThreadRouteRef } from "~/threadRoutes";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { startNewThreadFromContext } from "~/lib/chatThreadActions";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { SidebarContent, SidebarGroup, useSidebar } from "../ui/sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { SidebarThreadHeader } from "../sidebar/SidebarThreadHeader";
import { deriveMasterWorkspace, isMasterThreadTitle } from "./MasterStatusBoard.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import { useMasterWorkspaceEnabled } from "./useMasterSettings";
import {
  ThreadRowLeadingStatus,
  ThreadRowTrailingStatus,
  ThreadWorktreeIndicator,
} from "../ThreadStatusIndicators";

export const SHORTCUTS_STORAGE_KEY = "t3code:master-workspace-shortcuts";

export function readMasterWorkspaceShortcuts(value: string | null): readonly string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((item): item is string => typeof item === "string"))]
      : [];
  } catch {
    return [];
  }
}

export function toggleMasterWorkspaceShortcut(
  current: readonly string[],
  key: string,
): readonly string[] {
  return current.includes(key) ? current.filter((item) => item !== key) : [...current, key];
}

function shortTitle(title: string) {
  return title.replace(/^(master|card)\s*:\s*/i, "");
}

function matchesSearch(title: string, query: string) {
  return title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}

function projectWorkSummary(
  group: ReturnType<typeof deriveMasterWorkspace>["activeProjects"][number],
) {
  if (group.masters.length) return `${group.masters.length} Masters`;
  if (group.oneOffs.length) return `${group.oneOffs.length} Chats`;
  return `${group.orphanCards.length} Orphan Cards`;
}

type ThreadRow = ReturnType<typeof useThreadShells>[number];

function ThreadButton({
  thread,
  active,
  selected,
  nested,
  pin,
  onClick,
}: {
  thread: ThreadRow;
  active: boolean;
  selected?: boolean;
  nested?: boolean;
  pin?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      className={cn(
        "min-h-11 w-full justify-start gap-2 px-2 text-xs font-normal",
        nested && "pl-4 text-muted-foreground",
        (active || selected) && "bg-sidebar-row-active text-sidebar-foreground",
      )}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      {pin ? <PinIcon className="size-3 shrink-0 text-muted-foreground" /> : null}
      <ThreadRowLeadingStatus thread={thread} />
      <span className="min-w-0 flex-1 truncate text-left">{shortTitle(thread.title)}</span>
      <ThreadWorktreeIndicator thread={thread} />
      <ThreadRowTrailingStatus thread={thread} />
    </Button>
  );
}

/**
 * Mount point for AppSidebarLayout. Reads its own setting and falls back to
 * whichever upstream sidebar would otherwise render.
 */
export function MasterWorkspaceSidebarSlot(props: { readonly fallback: ReactNode }) {
  return useMasterWorkspaceEnabled() ? <MasterWorkspaceSidebar /> : props.fallback;
}

function MasterWorkspaceSidebar() {
  const projects = useProjects();
  const threads = useThreadShells();
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const activeRef = resolveThreadRouteRef(params);
  const { isMobile, setOpenMobile } = useSidebar();
  const newThreadContext = useHandleNewThread();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [shortcutIds, setShortcutIds] = useState<readonly string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [openProjectKeys, setOpenProjectKeys] = useState<ReadonlySet<string>>(new Set());
  const [settledExpanded, setSettledExpanded] = useState(false);

  useEffect(() => {
    setShortcutIds(
      readMasterWorkspaceShortcuts(window.localStorage.getItem(SHORTCUTS_STORAGE_KEY)),
    );
  }, []);

  const visibleThreads = useMemo(
    () => threads.filter((thread) => thread.archivedAt == null),
    [threads],
  );
  const masters = useMemo(
    () => visibleThreads.filter((thread) => isMasterThreadTitle(thread.title)),
    [visibleThreads],
  );
  const workspace = useMemo(() => deriveMasterWorkspace(threads), [threads]);
  const shortcutMasters = masters.filter((thread) =>
    shortcutIds.includes(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
  );
  const searchResults = useMemo(
    () =>
      searchQuery.trim()
        ? visibleThreads.filter((thread) => matchesSearch(thread.title, searchQuery))
        : [],
    [searchQuery, visibleThreads],
  );

  useEffect(
    () => setActiveSearchIndex((index) => Math.min(index, Math.max(searchResults.length - 1, 0))),
    [searchResults.length],
  );

  const openThread = (thread: (typeof threads)[number]) => {
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
    });
  };
  const toggleShortcut = (key: string) => {
    setShortcutIds((current) => {
      const next = toggleMasterWorkspaceShortcut(current, key);
      try {
        window.localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* session state still works */
      }
      return next;
    });
  };
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && searchResults.length) {
      event.preventDefault();
      setActiveSearchIndex((index) => (index + 1) % searchResults.length);
    } else if (event.key === "ArrowUp" && searchResults.length) {
      event.preventDefault();
      setActiveSearchIndex((index) => (index - 1 + searchResults.length) % searchResults.length);
    } else if (event.key === "Enter" && searchResults[activeSearchIndex]) {
      event.preventDefault();
      openThread(searchResults[activeSearchIndex]);
    } else if (event.key === "Escape") setSearchQuery("");
  };
  const onNewThread = (event: MouseEvent) => {
    if (projects.length > 1 && !event.shiftKey) {
      if (isMobile) setOpenMobile(false);
      openCommandPalette({ open: "new-thread-in" });
      return;
    }
    if (isMobile) setOpenMobile(false);
    void startNewThreadFromContext({
      activeDraftThread: newThreadContext.activeDraftThread,
      activeThread: newThreadContext.activeThread ?? undefined,
      defaultProjectRef: newThreadContext.defaultProjectRef,
      handleNewThread: newThreadContext.handleNewThread,
    });
  };

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        className="gap-0"
        fixedHeader={
          <SidebarGroup className="p-[var(--sidebar-content-inset)] pt-1">
            <SidebarThreadHeader
              hasProjects={projects.length > 0}
              projectScope={null}
              onNewProject={() => openCommandPalette({ open: "add-project" })}
              onNewThread={onNewThread}
              newThreadDisabled={false}
              newThreadShortcutLabel={undefined}
              newThreadInProjectShortcutLabel={undefined}
              showNewThreadInProjectHint={projects.length > 1}
              searchInputRef={searchInputRef}
              searchQuery={searchQuery}
              onSearchQueryChange={setSearchQuery}
              onSearchKeyDown={onSearchKeyDown}
              isSearching={Boolean(searchQuery.trim())}
              searchResultCount={searchResults.length}
              activeSearchResultIndex={activeSearchIndex}
              onClearSearch={() => setSearchQuery("")}
            />
          </SidebarGroup>
        }
      >
        {searchQuery.trim() ? (
          <SidebarGroup
            className="px-[var(--sidebar-content-inset)] py-2"
            id="sidebar-thread-search-results"
            role="listbox"
          >
            {searchResults.map((thread, index) => (
              <ThreadButton
                key={scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))}
                thread={thread}
                active={false}
                selected={index === activeSearchIndex}
                onClick={() => openThread(thread)}
              />
            ))}
          </SidebarGroup>
        ) : (
          <>
            <SidebarGroup className="px-[var(--sidebar-content-inset)] py-2">
              <p className="px-[var(--sidebar-row-content-inset)] pb-1 text-[11px] font-medium text-muted-foreground">
                Pinned
              </p>
              {shortcutMasters.length === 0 ? (
                <p className="px-[var(--sidebar-row-content-inset)] py-2 text-xs text-muted-foreground">
                  Pin a Master to keep it here.
                </p>
              ) : (
                shortcutMasters.map((thread) => (
                  <ThreadButton
                    key={scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))}
                    thread={thread}
                    active={
                      activeRef
                        ? scopedThreadKey(activeRef) ===
                          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
                        : false
                    }
                    pin
                    onClick={() => openThread(thread)}
                  />
                ))
              )}
            </SidebarGroup>
            <SidebarGroup className="px-[var(--sidebar-content-inset)] py-2">
              <p className="px-[var(--sidebar-row-content-inset)] pb-1 text-[11px] font-medium text-muted-foreground">
                Projects
              </p>
              {workspace.activeProjects.map((group) => {
                const projectKey = `${group.environmentId}:${group.projectId}`;
                const project = projects.find(
                  (item) =>
                    item.environmentId === group.environmentId && item.id === group.projectId,
                );
                if (!project) return null;
                const hasActiveThread = activeRef
                  ? threads.some(
                      (thread) =>
                        thread.environmentId === group.environmentId &&
                        (thread.projectId === group.projectId ||
                          group.masters.some((board) =>
                            board.cards.some((card) => card.id === thread.id),
                          )) &&
                        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) ===
                          scopedThreadKey(activeRef),
                    )
                  : false;
                const open = hasActiveThread || openProjectKeys.has(projectKey);
                return (
                  <Collapsible
                    key={projectKey}
                    open={open}
                    onOpenChange={(next) =>
                      setOpenProjectKeys((current) => {
                        const updated = new Set(current);
                        if (next) updated.add(projectKey);
                        else updated.delete(projectKey);
                        return updated;
                      })
                    }
                  >
                    <CollapsibleTrigger className="flex min-h-11 w-full items-center gap-2 rounded-md px-[var(--sidebar-row-content-inset)] text-left text-xs hover:bg-sidebar-accent">
                      <ChevronDownIcon
                        className={cn(
                          "size-3 shrink-0 transition-transform",
                          !open && "-rotate-90",
                        )}
                      />
                      <ProjectFavicon project={project} className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{project.title}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {projectWorkSummary(group)}
                      </span>
                    </CollapsibleTrigger>
                    <CollapsiblePanel className="pl-3">
                      {group.masters.map((board) => {
                        const master = board.master;
                        const key = scopedThreadKey(
                          scopeThreadRef(master.environmentId, master.id),
                        );
                        return (
                          <div key={key} className="mb-1">
                            <div className="flex items-center">
                              <ThreadButton
                                thread={master}
                                active={activeRef ? scopedThreadKey(activeRef) === key : false}
                                onClick={() => openThread(master)}
                              />
                              <Button
                                variant="ghost"
                                className="min-h-11 min-w-11"
                                aria-label={
                                  shortcutIds.includes(key) ? "Unpin Master" : "Pin Master"
                                }
                                onClick={() => toggleShortcut(key)}
                              >
                                <PinIcon
                                  className={cn(
                                    "size-3",
                                    shortcutIds.includes(key) && "fill-current",
                                  )}
                                />
                              </Button>
                            </div>
                            {board.cards.map((card) => (
                              <ThreadButton
                                key={scopedThreadKey(scopeThreadRef(card.environmentId, card.id))}
                                thread={card}
                                active={
                                  activeRef
                                    ? scopedThreadKey(activeRef) ===
                                      scopedThreadKey(scopeThreadRef(card.environmentId, card.id))
                                    : false
                                }
                                nested
                                onClick={() => openThread(card)}
                              />
                            ))}
                          </div>
                        );
                      })}
                      {group.oneOffs.length ? (
                        <div className="mt-1 border-t border-sidebar-border pt-1">
                          <p className="px-2 py-1 text-[10px] font-medium text-muted-foreground">
                            Chats
                          </p>
                          {group.oneOffs.map((thread) => (
                            <ThreadButton
                              key={scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))}
                              thread={thread}
                              active={
                                activeRef
                                  ? scopedThreadKey(activeRef) ===
                                    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
                                  : false
                              }
                              onClick={() => openThread(thread)}
                            />
                          ))}
                        </div>
                      ) : null}
                      {group.orphanCards.length ? (
                        <div className="mt-1 border-t border-sidebar-border pt-1">
                          <p className="px-2 py-1 text-[10px] font-medium text-muted-foreground">
                            Orphan Cards
                          </p>
                          {group.orphanCards.map((thread) => (
                            <ThreadButton
                              key={scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))}
                              thread={thread}
                              active={
                                activeRef
                                  ? scopedThreadKey(activeRef) ===
                                    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
                                  : false
                              }
                              nested
                              onClick={() => openThread(thread)}
                            />
                          ))}
                        </div>
                      ) : null}
                    </CollapsiblePanel>
                  </Collapsible>
                );
              })}
            </SidebarGroup>
            {workspace.settledProjects.length ? (
              <SidebarGroup className="px-[var(--sidebar-content-inset)] py-2">
                <Collapsible open={settledExpanded} onOpenChange={setSettledExpanded}>
                  <CollapsibleTrigger className="flex min-h-11 w-full items-center gap-2 rounded-md px-[var(--sidebar-row-content-inset)] text-left text-xs hover:bg-sidebar-accent">
                    <ChevronDownIcon
                      className={cn(
                        "size-3 shrink-0 transition-transform",
                        !settledExpanded && "-rotate-90",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      Settled (
                      {workspace.settledProjects.reduce(
                        (count, group) => count + group.visibleCount,
                        0,
                      )}
                      )
                    </span>
                  </CollapsibleTrigger>
                  <CollapsiblePanel className="pl-3">
                    {workspace.settledProjects.map((group) => {
                      const project = projects.find(
                        (item) =>
                          item.environmentId === group.environmentId && item.id === group.projectId,
                      );
                      if (!project) return null;
                      return (
                        <div key={`${group.environmentId}:${group.projectId}`} className="py-1">
                          <div className="flex items-center gap-2 px-2 text-[11px] text-muted-foreground">
                            <ProjectFavicon project={project} className="size-3.5" />
                            {project.title}
                          </div>
                          {group.masters.map((board) => (
                            <div key={board.master.id}>
                              <ThreadButton
                                thread={board.master}
                                active={false}
                                onClick={() => openThread(board.master)}
                              />
                              {board.cards.map((card) => (
                                <ThreadButton
                                  key={card.id}
                                  thread={card}
                                  active={false}
                                  nested
                                  onClick={() => openThread(card)}
                                />
                              ))}
                            </div>
                          ))}
                          {group.oneOffs.length ? (
                            <div className="mt-1 border-t border-sidebar-border pt-1">
                              <p className="px-2 py-1 text-[10px] font-medium text-muted-foreground">
                                Chats
                              </p>
                              {group.oneOffs.map((thread) => (
                                <ThreadButton
                                  key={thread.id}
                                  thread={thread}
                                  active={false}
                                  onClick={() => openThread(thread)}
                                />
                              ))}
                            </div>
                          ) : null}
                          {group.orphanCards.map((thread) => (
                            <ThreadButton
                              key={thread.id}
                              thread={thread}
                              active={false}
                              nested
                              onClick={() => openThread(thread)}
                            />
                          ))}
                        </div>
                      );
                    })}
                  </CollapsiblePanel>
                </Collapsible>
              </SidebarGroup>
            ) : null}
          </>
        )}
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
