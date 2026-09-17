import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ChevronDownIcon, PinIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";

import { cn } from "~/lib/utils";
import { isElectron } from "~/env";
import { openCommandPalette } from "~/commandPaletteBus";
import { useProjects, useThreadShells } from "~/state/entities";
import { buildThreadRouteParams, resolveThreadRouteRef } from "~/threadRoutes";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { startNewThreadFromContext } from "~/lib/chatThreadActions";
import { Button } from "./ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";
import { SidebarContent, SidebarGroup, useSidebar } from "./ui/sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { SidebarThreadHeader } from "./sidebar/SidebarThreadHeader";
import { deriveMasterBoard, isMasterThreadTitle } from "./master/MasterStatusBoard.logic";

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

type ThreadRow = { id: string; environmentId: string; title: string; projectId: string | null };

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
      <span className="min-w-0 flex-1 truncate text-left">{shortTitle(thread.title)}</span>
    </Button>
  );
}

export default function MasterWorkspaceSidebar() {
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
              {projects.map((project) => {
                const projectKey = `${project.environmentId}:${project.id}`;
                const projectThreads = threads.filter(
                  (thread) =>
                    thread.environmentId === project.environmentId &&
                    thread.projectId === project.id,
                );
                const projectMasters = projectThreads.filter(
                  (thread) => thread.archivedAt == null && isMasterThreadTitle(thread.title),
                );
                const oneOffs = projectThreads.filter(
                  (thread) =>
                    thread.archivedAt == null &&
                    !isMasterThreadTitle(thread.title) &&
                    !/^card\s*:/i.test(thread.title),
                );
                const ownedCardIds = new Set(
                  projectMasters.flatMap(
                    (master) =>
                      deriveMasterBoard(master, projectThreads)?.cards.map((card) => card.id) ?? [],
                  ),
                );
                const orphanCards = projectThreads.filter(
                  (thread) =>
                    thread.archivedAt == null &&
                    /^card\s*:/i.test(thread.title) &&
                    !ownedCardIds.has(thread.id),
                );
                const hasActiveThread = activeRef
                  ? projectThreads.some(
                      (thread) =>
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
                      <span className="min-w-0 flex-1 truncate">{project.title}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {projectMasters.length} Masters
                      </span>
                    </CollapsibleTrigger>
                    <CollapsiblePanel className="pl-3">
                      {projectMasters.map((master) => {
                        const board = deriveMasterBoard(master, projectThreads);
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
                            {board?.cards.map((card) => (
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
                      {oneOffs.map((thread) => (
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
                      {orphanCards.length ? (
                        <div className="mt-1 border-t border-sidebar-border pt-1">
                          <p className="px-2 py-1 text-[10px] font-medium text-muted-foreground">
                            Other work
                          </p>
                          {orphanCards.map((thread) => (
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
          </>
        )}
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
