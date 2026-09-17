import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ChevronDownIcon, PinIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { cn } from "~/lib/utils";
import { isElectron } from "~/env";
import { useProjects, useThreadShells } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";
import { Button } from "./ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";
import { SidebarContent, SidebarGroup } from "./ui/sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { deriveMasterBoard, isMasterThreadTitle } from "./master/MasterStatusBoard.logic";

const SHORTCUTS_STORAGE_KEY = "t3code:master-workspace-shortcuts";

function shortTitle(title: string) {
  return title.replace(/^(master|card)\s*:\s*/i, "");
}

export default function MasterWorkspaceSidebar() {
  const projects = useProjects();
  const threads = useThreadShells();
  const navigate = useNavigate();
  const [shortcutIds, setShortcutIds] = useState<readonly string[]>([]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(SHORTCUTS_STORAGE_KEY);
      if (stored) {
        const parsed: unknown = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          setShortcutIds([
            ...new Set(parsed.filter((value): value is string => typeof value === "string")),
          ]);
        }
      }
    } catch {
      // Local shortcuts are an enhancement. A blocked storage backend leaves the tree usable.
    }
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
  const openThread = (thread: (typeof threads)[number]) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
    });
  };
  const toggleShortcut = (threadId: string) => {
    setShortcutIds((current) => {
      const next = current.includes(threadId)
        ? current.filter((id) => id !== threadId)
        : [...current, threadId];
      try {
        window.localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Keep the current session responsive even if persistence is unavailable.
      }
      return next;
    });
  };

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent className="gap-0">
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
              <Button
                key={thread.id}
                variant="ghost"
                className="h-8 w-full justify-start gap-2 px-[var(--sidebar-row-content-inset)] text-xs font-normal"
                onClick={() => openThread(thread)}
              >
                <PinIcon className="size-3 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-left">
                  {shortTitle(thread.title)}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {thread.projectId}
                </span>
              </Button>
            ))
          )}
        </SidebarGroup>
        <SidebarGroup className="px-[var(--sidebar-content-inset)] py-2">
          <p className="px-[var(--sidebar-row-content-inset)] pb-1 text-[11px] font-medium text-muted-foreground">
            Projects
          </p>
          {projects.map((project) => {
            const projectThreads = visibleThreads.filter(
              (thread) =>
                thread.environmentId === project.environmentId && thread.projectId === project.id,
            );
            const projectMasters = projectThreads.filter((thread) =>
              isMasterThreadTitle(thread.title),
            );
            const oneOffs = projectThreads.filter(
              (thread) => !isMasterThreadTitle(thread.title) && !/^card\s*:/i.test(thread.title),
            );
            const ownedCardIds = new Set(
              projectMasters.flatMap(
                (master) =>
                  deriveMasterBoard(master, projectThreads)?.cards.map((card) => card.id) ?? [],
              ),
            );
            const orphanCards = projectThreads.filter(
              (thread) => /^card\s*:/i.test(thread.title) && !ownedCardIds.has(thread.id),
            );
            return (
              <Collapsible key={`${project.environmentId}:${project.id}`} defaultOpen>
                <CollapsibleTrigger className="flex h-9 w-full items-center gap-2 rounded-md px-[var(--sidebar-row-content-inset)] text-left text-xs hover:bg-sidebar-accent">
                  <ChevronDownIcon className="size-3 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{project.title}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {projectMasters.length} Masters
                  </span>
                </CollapsibleTrigger>
                <CollapsiblePanel className="pl-3">
                  {projectMasters.map((master) => {
                    const board = deriveMasterBoard(master, projectThreads);
                    return (
                      <div key={master.id} className="mb-1">
                        <div className="flex items-center">
                          <Button
                            variant="ghost"
                            className="h-8 min-w-0 flex-1 justify-start gap-2 px-2 text-xs font-normal"
                            onClick={() => openThread(master)}
                          >
                            <span className="min-w-0 flex-1 truncate text-left">
                              {shortTitle(master.title)}
                            </span>
                            {shortcutIds.includes(
                              scopedThreadKey(scopeThreadRef(master.environmentId, master.id)),
                            ) ? (
                              <PinIcon className="size-3" />
                            ) : null}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={
                              shortcutIds.includes(
                                scopedThreadKey(scopeThreadRef(master.environmentId, master.id)),
                              )
                                ? "Unpin Master"
                                : "Pin Master"
                            }
                            onClick={() =>
                              toggleShortcut(
                                scopedThreadKey(scopeThreadRef(master.environmentId, master.id)),
                              )
                            }
                          >
                            <PinIcon
                              className={cn(
                                "size-3",
                                shortcutIds.includes(
                                  scopedThreadKey(scopeThreadRef(master.environmentId, master.id)),
                                ) && "fill-current",
                              )}
                            />
                          </Button>
                        </div>
                        {board?.cards.map((card) => (
                          <Button
                            key={card.id}
                            variant="ghost"
                            className="h-7 w-full justify-start px-4 text-xs font-normal text-muted-foreground"
                            onClick={() => openThread(card)}
                          >
                            <span className="min-w-0 truncate">{shortTitle(card.title)}</span>
                          </Button>
                        ))}
                      </div>
                    );
                  })}
                  {oneOffs.map((thread) => (
                    <Button
                      key={thread.id}
                      variant="ghost"
                      className="h-7 w-full justify-start px-2 text-xs font-normal text-muted-foreground"
                      onClick={() => openThread(thread)}
                    >
                      <span className="min-w-0 truncate">{thread.title}</span>
                    </Button>
                  ))}
                  {orphanCards.length > 0 ? (
                    <div className="mt-1 border-t border-sidebar-border pt-1">
                      <p className="px-2 py-1 text-[10px] font-medium text-muted-foreground">
                        Other work
                      </p>
                      {orphanCards.map((thread) => (
                        <Button
                          key={thread.id}
                          variant="ghost"
                          className="h-7 w-full justify-start px-2 text-xs font-normal text-muted-foreground"
                          onClick={() => openThread(thread)}
                        >
                          <span className="min-w-0 truncate">{shortTitle(thread.title)}</span>
                        </Button>
                      ))}
                    </div>
                  ) : null}
                </CollapsiblePanel>
              </Collapsible>
            );
          })}
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
