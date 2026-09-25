import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { effectiveSnoozed, snoozeWakeLabel } from "@t3tools/client-runtime/state/thread-settled";
import {
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { useAtomValue } from "@effect/atom-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useNavigate, useParams } from "@tanstack/react-router";

import { isElectron } from "~/env";
import { isCommandPaletteOpen, openCommandPalette } from "~/commandPaletteBus";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "~/keybindings";
import { isModelPickerOpen } from "~/modelPickerVisibility";
import { useShortcutModifierState } from "~/shortcutModifierState";
import { useTerminalFocus } from "~/hooks/useTerminalFocus";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { isPreviewFocused } from "~/lib/previewFocus";
import { selectActiveRightPanel, useRightPanelStore } from "~/rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "~/terminalUiStateStore";
import { useProjects, useServerConfigs } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useClientSettings } from "~/hooks/useSettings";
import { useUiStateStore } from "~/uiStateStore";
import { selectProjectGroupingSettings } from "~/logicalProject";
import {
  deriveProviderEntriesByEnvironment,
  type ProviderInstanceEntry,
} from "~/providerInstances";
import { buildSidebarProjectSnapshots } from "~/sidebarProjectGrouping";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams, resolveThreadRouteRef } from "~/threadRoutes";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useThreadActionMenu } from "~/hooks/useThreadActionMenu";
import { startNewThreadFromContext } from "~/lib/chatThreadActions";
import { resolveRenameCommit } from "../chat/ChatHeader";
import { SidebarContent, SidebarGroup, useSidebar } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { TooltipProvider } from "../ui/tooltip";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { SidebarThreadHeader } from "../sidebar/SidebarThreadHeader";
import {
  EMPTY_PROVIDER_ENTRIES,
  SidebarAttentionRollup,
  SidebarDisclosureButton,
  SidebarSectionHeader,
  SidebarThreadRow,
} from "../Sidebar";
import {
  resolveAdjacentThreadId,
  resolveSidebarThreadStatus,
  sortPinnedThreadsForSidebar,
  useThreadJumpHintVisibility,
} from "../Sidebar.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  deriveMasterWorkspace,
  collapsedAttention,
  disclosureKey,
  isDisclosureOpen,
  masterProjectStoreKeys,
  onNavigate,
  persistedDisclosureWrites,
  readPersistedDisclosure,
  setDisclosure,
  visibleWorkspaceRows,
  navigableRows,
  nextUnparkedKey,
  projectWorkSummary,
  type Disclosure,
  type NavigationSource,
  type MasterShelf,
  type MasterShelfBoard,
  type MasterWorkspaceProject,
} from "./MasterStatusBoard.logic";
import { useMasterLineageThreads } from "./useMasterLineageThreads";
import { useMasterWorkspaceEnabled } from "./useMasterSettings";

type ThreadRow = EnvironmentThreadShell;
type ProjectGroup = MasterWorkspaceProject<ThreadRow>;

function rowKey(thread: ThreadRow): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

function projectKeyOf(thread: { environmentId: string; projectId: string }): string {
  return `${thread.environmentId}:${thread.projectId}`;
}

function matchesSearch(title: string, query: string) {
  return title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}

/**
 * Mount point for AppSidebarLayout. Reads its own setting and falls back to
 * whichever upstream sidebar would otherwise render.
 */
export function MasterWorkspaceSidebarSlot(props: { readonly fallback: ReactNode }) {
  return useMasterWorkspaceEnabled() ? <MasterWorkspaceSidebar /> : props.fallback;
}

interface RowContext {
  readonly activeKey: string | null;
  readonly selectedKey?: string | null;
  readonly jumpLabelByKey: ReadonlyMap<string, string>;
  readonly renaming: { readonly key: string; readonly title: string } | null;
  readonly now: string;
  readonly isMobile: boolean;
  // Inside a project group, whose header already names the project: rows of
  // that project drop their project icon, rows of another project keep it.
  readonly groupTitle?: string;
  // On the Pinned shelf the shelf itself says pinned, so rows drop the pin.
  readonly onPinnedShelf?: boolean;
  // On the Settled shelf every row reads settled, archived Masters included.
  readonly onSettledShelf?: boolean;
  readonly isMasterOpen: (board: { master: ThreadRow }) => boolean;
  readonly onToggleMaster: (board: { master: ThreadRow }) => void;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly timestampFormat: TimestampFormat;
  readonly projectByKey: ReadonlyMap<string, EnvironmentProject>;
  readonly projectTitleByKey: ReadonlyMap<string, string>;
  readonly environmentLabelById: ReadonlyMap<string, string>;
  readonly environmentMachineById: ReadonlyMap<string, EnvironmentMachineKind>;
  readonly providerEntriesByEnvironment: ReadonlyMap<
    string,
    ReadonlyMap<string, ProviderInstanceEntry>
  >;
  readonly onOpen: (thread: ThreadRow) => void;
  readonly onMenu: (thread: ThreadRow, position: { x: number; y: number }) => void;
  readonly onRenameStart: (thread: ThreadRow) => void;
  readonly onRenameChange: (title: string) => void;
  readonly onRenameCommit: (thread: ThreadRow, title: string) => void;
  readonly onRenameCancel: () => void;
}

// Settle, snooze, wake and unpin go through the row's action menu, where
// parking the open thread moves on to the next Master-workspace row, so the
// standard row's inline lifecycle buttons stay off.
const noLifecycleAction = () => {};

// A collapsible group's roll-up of the rows it hides, only while collapsed.
function hiddenAttention(open: boolean, threads: readonly ThreadRow[]) {
  return collapsedAttention(open, threads.map(resolveSidebarThreadStatus));
}

// Sub-level headings inside a project keep the rows' empty icon slot, so their
// labels share the titles' left edge.
const ICON_SLOT = <span aria-hidden className="size-4 shrink-0" />;

/** One thread, rendered by the standard sidebar's slim row. */
function MasterThreadRow({
  thread,
  context,
  toggle,
  attention,
}: {
  thread: ThreadRow;
  context: RowContext;
  toggle?: { expanded: boolean; onToggle: () => void; label: string } | undefined;
  attention?: ReturnType<typeof hiddenAttention>;
}) {
  const key = rowKey(thread);
  const projectKey = projectKeyOf(thread);
  const snoozedUntil =
    thread.snoozedUntil != null && effectiveSnoozed(thread, { now: context.now })
      ? thread.snoozedUntil
      : null;
  const renamingTitle = context.renaming?.key === key ? context.renaming.title : null;
  return (
    <SidebarThreadRow
      thread={thread}
      variant="slim"
      variantAction={
        snoozedUntil
          ? "unsnooze"
          : context.onSettledShelf || thread.settledOverride === "settled"
            ? "unsettle"
            : "settle"
      }
      settlementSupported={false}
      snoozeSupported={false}
      pinningSupported={false}
      isPinned={thread.pinnedAt != null && !context.onPinnedShelf}
      dropVerb={null}
      dragOverPinned={false}
      snoozeWakeLabelText={
        snoozedUntil ? snoozeWakeLabel(snoozedUntil, { now: context.now }) : null
      }
      wokeAt={null}
      isActive={context.activeKey === key || context.selectedKey === key}
      openPullRequestsInRightPanel={context.activeKey !== null}
      jumpLabel={context.jumpLabelByKey.get(key) ?? null}
      currentEnvironmentId={context.primaryEnvironmentId}
      environmentLabel={context.environmentLabelById.get(thread.environmentId) ?? null}
      environmentMachine={context.environmentMachineById.get(thread.environmentId) ?? "server"}
      project={context.projectByKey.get(projectKey) ?? null}
      projectDisplayName={context.projectTitleByKey.get(projectKey) ?? null}
      providerEntryByInstanceId={
        context.providerEntriesByEnvironment.get(thread.environmentId) ?? EMPTY_PROVIDER_ENTRIES
      }
      timestampFormat={context.timestampFormat}
      onThreadClick={() => context.onOpen(thread)}
      onThreadActivate={() => context.onOpen(thread)}
      onStartRename={() => context.onRenameStart(thread)}
      onRenameTitleChange={context.onRenameChange}
      onCommitRename={(_ref: ScopedThreadRef, title: string) =>
        context.onRenameCommit(thread, title)
      }
      onCancelRename={context.onRenameCancel}
      isRenaming={renamingTitle !== null}
      renamingTitle={renamingTitle ?? ""}
      onContextMenu={(_ref: ScopedThreadRef, position: { x: number; y: number }) =>
        context.onMenu(thread, position)
      }
      onSettle={noLifecycleAction}
      onUnsettle={noLifecycleAction}
      onSnooze={noLifecycleAction}
      onUnsnooze={noLifecycleAction}
      onUnpin={noLifecycleAction}
      onAcknowledgeWoke={noLifecycleAction}
      hideProjectIcon={
        context.groupTitle !== undefined &&
        context.projectTitleByKey.get(projectKey) === context.groupTitle
      }
      showStatusIcon
      {...(toggle ? { toggle } : {})}
      hiddenAttention={attention ?? null}
      actionsButton={context.isMobile ? "always" : "on-hover"}
    />
  );
}

/**
 * A Master and its Cards, flat like the default sidebar: lineage order and
 * the "Master:" / "Card:" titles carry the hierarchy. A structural Master only heads its Cards on this
 * shelf: it is archived, or its own row lives on another shelf. It renders as
 * an inert heading, so each thread stays navigable once.
 */
function MasterBoard({
  board,
  context,
}: {
  board: MasterShelfBoard<ThreadRow>;
  context: RowContext;
}) {
  const { master, cards, structural } = board;
  // A Master with Cards collapses them with a chevron in the leading icon
  // slot, on its row or, for a structural Master, on its heading.
  const open = context.isMasterOpen(board);
  const toggle = cards.length
    ? {
        expanded: open,
        onToggle: () => context.onToggleMaster(board),
        label: `${open ? "Collapse" : "Expand"} Cards of ${master.title}`,
      }
    : undefined;
  // Collapsed, the Master rolls up what its hidden Cards need.
  const attention = hiddenAttention(open, cards);
  return (
    <>
      {structural ? (
        <SidebarSectionHeader
          level="sub"
          icon={toggle ? <SidebarDisclosureButton {...toggle} /> : ICON_SLOT}
          label={master.title}
          status={attention ? <SidebarAttentionRollup status={attention} /> : null}
        />
      ) : (
        <MasterThreadRow thread={master} context={context} toggle={toggle} attention={attention} />
      )}
      {open
        ? cards.map((card) => (
            <MasterThreadRow key={rowKey(card)} thread={card} context={context} />
          ))
        : null}
    </>
  );
}

function ProjectGroupRows({
  group,
  title,
  context: outerContext,
}: {
  group: ProjectGroup;
  title: string;
  context: RowContext;
}) {
  const context = { ...outerContext, groupTitle: title };
  if (group.masters.length === 0 && group.oneOffs.length === 0 && group.orphanCards.length === 0) {
    return (
      <li className="list-none">
        <p className="px-2 py-2 text-[11px] text-muted-foreground">
          No threads yet. Start one with New thread.
        </p>
      </li>
    );
  }
  return (
    <>
      {group.masters.map((board) => (
        <MasterBoard key={rowKey(board.master)} board={board} context={context} />
      ))}
      {group.oneOffs.length ? (
        <>
          {/* A project of only chats needs no Chats heading: its header's
            summary ("1 chat") already says so. */}
          {group.masters.length || group.orphanCards.length ? (
            <SidebarSectionHeader level="sub" icon={ICON_SLOT} label="Chats" />
          ) : null}
          {group.oneOffs.map((thread) => (
            <MasterThreadRow key={rowKey(thread)} thread={thread} context={context} />
          ))}
        </>
      ) : null}
      {group.orphanCards.length ? (
        <>
          <SidebarSectionHeader level="sub" icon={ICON_SLOT} label="Orphan Cards" />
          {group.orphanCards.map((thread) => (
            <MasterThreadRow key={rowKey(thread)} thread={thread} context={context} />
          ))}
        </>
      ) : null}
    </>
  );
}

// A collapsed-by-default shelf at the bottom, labelled like the default
// sidebar's shelves: "Settled (3)" while closed, "Settled" once open.
function ShelfGroup({
  label,
  count,
  expanded,
  onExpandedChange,
  children,
}: {
  label: string;
  count: number;
  expanded: boolean;
  onExpandedChange: (open: boolean) => void;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <SidebarGroup className="px-[var(--sidebar-content-inset)] py-2">
      <ul role="list" className="flex flex-col gap-px">
        <SidebarSectionHeader
          label={expanded ? label : `${label} (${count})`}
          toggle={{ expanded, onToggle: () => onExpandedChange(!expanded) }}
        />
        {expanded ? children : null}
      </ul>
    </SidebarGroup>
  );
}

function MasterWorkspaceSidebar() {
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  // Logical project groups carry the same representative title and icon as the
  // standard sidebar, so worktrees inherit their parent project's presentation.
  const projectGroups = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: () => null,
      }),
    [primaryEnvironmentId, projectGroupingSettings, projects],
  );
  const projectGroupCount = projectGroups.length;
  const environmentIds = useMemo(
    () => [...new Set(projects.map((project) => project.environmentId))] as EnvironmentId[],
    [projects],
  );
  const threads = useMasterLineageThreads(environmentIds);
  const serverConfigs = useServerConfigs();
  const { environments } = useEnvironments();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  // The same row inputs the default sidebar derives for its thread rows.
  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const environmentMachineById = useMemo(
    () =>
      new Map(
        environments.map(
          (environment) =>
            [
              environment.environmentId,
              resolveEnvironmentMachineKind(environment.serverConfig),
            ] as const,
        ),
      ),
    [environments],
  );
  const providerEntriesByEnvironment = useMemo(
    () =>
      deriveProviderEntriesByEnvironment(
        [...serverConfigs].map(
          ([environmentId, config]) => [environmentId, config.providers] as const,
        ),
      ),
    [serverConfigs],
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const now = useNowMinute();
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const activeRef = resolveThreadRouteRef(params);
  const activeKey = activeRef ? scopedThreadKey(activeRef) : null;
  const { isMobile, setOpenMobile } = useSidebar();
  const newThreadContext = useHandleNewThread();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  // The route the router last reported (in memory: after a reload it lands again).
  const [route, setRoute] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ key: string; title: string } | null>(null);

  const capability = useCallback(
    (environmentId: EnvironmentId, name: "threadSnooze" | "threadSettlement") =>
      serverConfigs.get(environmentId)?.environment.capabilities[name] === true,
    [serverConfigs],
  );
  // Same precedence as the default sidebar: snooze, then settlement, then pin.
  const shelfOf = useCallback(
    (thread: ThreadRow): MasterShelf => {
      if (capability(thread.environmentId, "threadSnooze") && effectiveSnoozed(thread, { now })) {
        return "snoozed";
      }
      if (
        capability(thread.environmentId, "threadSettlement") &&
        thread.settledOverride === "settled"
      ) {
        return "settled";
      }
      return thread.pinnedAt != null ? "pinned" : "active";
    },
    [capability, now],
  );
  const liveThreads = useMemo(
    () => threads.filter((thread) => thread.archivedAt == null),
    [threads],
  );
  const workspace = useMemo(
    () =>
      deriveMasterWorkspace({
        threads,
        projects: projects.map((project) => ({
          environmentId: project.environmentId,
          id: project.id,
        })),
        shelfOf,
      }),
    [projects, shelfOf, threads],
  );
  // Pinned order follows the shared pin sort, same as the default sidebar.
  const pinnedEntries = useMemo(() => {
    const entryByKey = new Map(workspace.pinned.map((entry) => [rowKey(entry.thread), entry]));
    return sortPinnedThreadsForSidebar(workspace.pinned.map((entry) => entry.thread)).flatMap(
      (thread) => entryByKey.get(rowKey(thread)) ?? [],
    );
  }, [workspace.pinned]);
  const searchResults = useMemo(
    () =>
      searchQuery.trim()
        ? liveThreads.filter((thread) => matchesSearch(thread.title, searchQuery))
        : [],
    [searchQuery, liveThreads],
  );
  const projectByKey = useMemo(
    () => new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project])),
    [projects],
  );
  const projectPresentationByKey = useMemo(() => {
    const presentations = new Map<
      string,
      { project: (typeof projectGroups)[number]; title: string }
    >();
    for (const group of projectGroups) {
      for (const project of group.memberProjects) {
        presentations.set(`${project.environmentId}:${project.id}`, {
          project: group,
          title: group.displayName,
        });
      }
    }
    return presentations;
  }, [projectGroups]);
  // Disclosure records persist in the UI store across reloads: projects in
  // projectExpandedById under the keys masterProjectStoreKeys picks, Masters'
  // Cards and the shelves in masterWorkspaceExpandedById.
  const projectExpandedById = useUiStateStore((state) => state.projectExpandedById);
  const masterWorkspaceExpandedById = useUiStateStore((state) => state.masterWorkspaceExpandedById);
  const setProjectExpanded = useUiStateStore((state) => state.setProjectExpanded);
  const setMasterWorkspaceExpanded = useUiStateStore((state) => state.setMasterWorkspaceExpanded);
  const projectStoreKeys = useMemo(
    () =>
      masterProjectStoreKeys(
        projects,
        (project) =>
          projectPresentationByKey.get(`${project.environmentId}:${project.id}`)?.project,
      ),
    [projectPresentationByKey, projects],
  );
  const disclosure = useMemo(
    () =>
      readPersistedDisclosure(
        { projectExpandedById, masterWorkspaceExpandedById },
        projectStoreKeys,
      ),
    [masterWorkspaceExpandedById, projectExpandedById, projectStoreKeys],
  );
  const writeDisclosure = useCallback(
    (next: Disclosure) => {
      for (const write of persistedDisclosureWrites(disclosure, next, projectStoreKeys)) {
        if (write.slot === "project") setProjectExpanded(write.keys, write.open);
        else setMasterWorkspaceExpanded(write.keys, write.open);
      }
    },
    [disclosure, projectStoreKeys, setMasterWorkspaceExpanded, setProjectExpanded],
  );
  const setDisclosureState = useCallback(
    (update: (current: Disclosure) => Disclosure) => writeDisclosure(update(disclosure)),
    [disclosure, writeDisclosure],
  );
  const projectTitleByKey = useMemo(
    () =>
      new Map(
        [...projectPresentationByKey].map(([key, presentation]) => [key, presentation.title]),
      ),
    [projectPresentationByKey],
  );
  const projectOf = useCallback(
    (group: { environmentId: string; projectId: string }) => {
      const key = `${group.environmentId}:${group.projectId}`;
      const presentation = projectPresentationByKey.get(key);
      if (presentation) return presentation;
      const project = projectByKey.get(key);
      return project ? { project, title: project.title } : null;
    },
    [projectByKey, projectPresentationByKey],
  );
  // The workspace as rendered: Pinned in its sidebar order.
  const shownWorkspace = useMemo(
    () => ({ ...workspace, pinned: pinnedEntries }),
    [pinnedEntries, workspace],
  );
  // Every navigation goes through onNavigate (MasterStatusBoard.logic): user
  // navigations from openThread below, route changes (initial load, deep
  // link, back/forward) from this effect. It runs before paint so a landing
  // group never flashes shut, and re-runs when the workspace changes, so a
  // thread that arrives late is still revealed.
  const navigateDisclosureTo = useCallback(
    (target: string | null, source: NavigationSource) => {
      const next = onNavigate(shownWorkspace, { disclosure, route }, rowKey, target, source);
      if (next === null) return;
      writeDisclosure(next.disclosure);
      if (next.route !== route) setRoute(next.route);
    },
    [disclosure, route, shownWorkspace, writeDisclosure],
  );
  useLayoutEffect(() => {
    navigateDisclosureTo(activeKey, "route");
  }, [activeKey, navigateDisclosureTo]);
  const isOpen = useCallback((key: string) => isDisclosureOpen(disclosure, key), [disclosure]);
  const isProjectOpen = useCallback(
    (group: ProjectGroup) => isOpen(disclosureKey.project(group)),
    [isOpen],
  );
  const setProjectsOpen = useCallback(
    (groups: readonly ProjectGroup[], open: boolean) =>
      setDisclosureState((current) =>
        setDisclosure(current, groups.map(disclosureKey.project), open),
      ),
    [setDisclosureState],
  );
  const isMasterOpen = useCallback(
    (board: { master: ThreadRow }) => isOpen(disclosureKey.master(rowKey(board.master))),
    [isOpen],
  );
  const toggleMaster = useCallback(
    (board: { master: ThreadRow }) =>
      setDisclosureState((current) =>
        setDisclosure(current, [disclosureKey.master(rowKey(board.master))], !isMasterOpen(board)),
      ),
    [isMasterOpen, setDisclosureState],
  );
  const snoozedExpanded = isOpen(disclosureKey.shelf("snoozed"));
  const settledExpanded = isOpen(disclosureKey.shelf("settled"));
  const setShelfOpen = useCallback(
    (shelf: "snoozed" | "settled", open: boolean) =>
      setDisclosureState((current) => setDisclosure(current, [disclosureKey.shelf(shelf)], open)),
    [setDisclosureState],
  );

  const settledRows = useMemo(
    () => workspace.settled.filter((thread) => projectOf(thread)),
    [projectOf, workspace.settled],
  );

  // Rows in on-screen order, for mod+1..9. Next/previous thread and "next
  // after parking" also keep the active thread's position while a collapsed
  // group hides it, so they still move from it.
  const rowsFor = useCallback(
    (keep: string | null) =>
      searchQuery.trim()
        ? searchResults
        : visibleWorkspaceRows(shownWorkspace, disclosure, rowKey, {
            keep,
            // Only rows that actually render: groups without a project record don't.
            shows: (group) => projectOf(group) !== null,
          }),
    [disclosure, projectOf, searchQuery, searchResults, shownWorkspace],
  );
  const orderedRows = useMemo(() => rowsFor(null), [rowsFor]);
  const traversalKeys = useMemo(() => rowsFor(activeKey).map(rowKey), [activeKey, rowsFor]);
  // Shelves are exclusive, so every row key is unique.
  const orderedKeys = useMemo(() => orderedRows.map(rowKey), [orderedRows]);
  const rowByKey = useMemo(
    () => new Map(orderedRows.map((thread) => [rowKey(thread), thread])),
    [orderedRows],
  );

  // Clamped at read time so a shrinking result list never points past its end.
  const selectedSearchIndex = Math.min(activeSearchIndex, Math.max(searchResults.length - 1, 0));
  const changeSearchQuery = (query: string) => {
    setSearchQuery(query);
    setActiveSearchIndex(0);
  };

  const openThread = useCallback(
    (thread: ThreadRow) => {
      // An explicit navigation reveals the landing thread even when it is
      // already the active one (e.g. picked again from search).
      navigateDisclosureTo(rowKey(thread), "user");
      if (isMobile) setOpenMobile(false);
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
      });
    },
    [isMobile, navigate, navigateDisclosureTo, setOpenMobile],
  );

  const routePreviewOpen = useRightPanelStore((state) =>
    activeRef ? selectActiveRightPanel(state.byThreadKey, activeRef) === "preview" : false,
  );
  const routeTerminalOpen = useTerminalUiStateStore((state) =>
    activeRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, activeRef).terminalOpen
      : false,
  );
  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen() || isModelPickerOpen()) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: routeTerminalOpen,
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      const navigateToKey = (key: string | null) => {
        const thread = key ? rowByKey.get(key) : undefined;
        if (!thread) return;
        event.preventDefault();
        event.stopPropagation();
        openThread(thread);
      };
      const direction = threadTraversalDirectionFromCommand(command);
      if (direction !== null) {
        navigateToKey(
          resolveAdjacentThreadId({
            threadIds: traversalKeys,
            currentThreadId: activeKey,
            direction,
          }),
        );
        return;
      }
      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex !== null) navigateToKey(orderedKeys[jumpIndex] ?? null);
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [activeKey, keybindings, openThread, orderedKeys, rowByKey, routeTerminalOpen, traversalKeys]);

  // chat.new opens the "New thread in" picker whenever there is a real choice,
  // like the default sidebar, even if the legacy sidebar preference is saved
  // underneath this one. Capture phase runs before the route's global handler,
  // which skips events already handled here.
  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || isCommandPaletteOpen() || projectGroupCount <= 1) return;
      // Same context as the route's handler, so both resolve the same command.
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: routeTerminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen: routePreviewOpen,
        },
      });
      if (command !== "chat.new") return;
      event.preventDefault();
      event.stopPropagation();
      openCommandPalette({ open: "new-thread-in" });
    };
    window.addEventListener("keydown", onWindowKeyDown, true);
    return () => window.removeEventListener("keydown", onWindowKeyDown, true);
  }, [keybindings, projectGroupCount, routePreviewOpen, routeTerminalOpen]);

  // Hints show only while the held modifiers exactly match a jump binding.
  const shortcutModifiers = useShortcutModifierState();
  const terminalFocused = useTerminalFocus();
  const { showThreadJumpHints, updateThreadJumpHintsVisibility } = useThreadJumpHintVisibility();
  const shouldShowJumpHintsNow = shouldShowThreadJumpHintsForModifiers(
    shortcutModifiers,
    keybindings,
    {
      platform: navigator.platform,
      context: {
        terminalFocus: terminalFocused,
        terminalOpen: routeTerminalOpen,
        modelPickerOpen: isModelPickerOpen(),
      },
    },
  );
  useEffect(() => {
    updateThreadJumpHintsVisibility(shouldShowJumpHintsNow);
  }, [shouldShowJumpHintsNow, updateThreadJumpHintsVisibility]);
  const jumpLabelByKey = useMemo(() => {
    const labels = new Map<string, string>();
    if (!showThreadJumpHints) return labels;
    for (const [index, key] of orderedKeys.entries()) {
      const command = threadJumpCommandForIndex(index);
      if (!command) break;
      const label = shortcutLabelForCommand(keybindings, command);
      if (label) labels.set(key, label);
    }
    return labels;
  }, [keybindings, orderedKeys, showThreadJumpHints]);

  // One shared action menu (the chat header's) for every row.
  const menuTargetRef = useRef<ThreadRow | null>(null);
  const startRename = useCallback(() => {
    const thread = menuTargetRef.current;
    if (thread) setRenaming({ key: rowKey(thread), title: thread.title });
  }, []);
  const { openMenu } = useThreadActionMenu({
    threadRef: null,
    projectCwd: null,
    onStartRename: startRename,
  });
  // Synced in the commit that changes the route (layout effects run
  // synchronously there), so a park completing after a navigation always sees
  // the new route and never redirects the user.
  const activeKeyRef = useRef(activeKey);
  useLayoutEffect(() => {
    activeKeyRef.current = activeKey;
  }, [activeKey]);
  const onMenu = useCallback(
    (thread: ThreadRow, position: { x: number; y: number }) => {
      menuTargetRef.current = thread;
      const key = rowKey(thread);
      // Like the default sidebar: settling or snoozing the open thread from its
      // row moves on to the next unparked row (planned now, in today's order),
      // or to a new thread in its project.
      const nextKey = nextUnparkedKey(traversalKeys, key, (candidate) => {
        const row = rowByKey.get(candidate);
        return row === undefined || shelfOf(row) === "snoozed" || shelfOf(row) === "settled";
      });
      const next = nextKey ? rowByKey.get(nextKey) : undefined;
      openMenu(position, {
        threadRef: scopeThreadRef(thread.environmentId, thread.id),
        projectCwd: projectOf(thread)?.project.workspaceRoot ?? null,
        onParked: () => {
          // A navigation made while the command ran wins over ours.
          if (activeKeyRef.current !== key) return;
          if (next) openThread(next);
          else
            void newThreadContext.handleNewThread(
              scopeProjectRef(thread.environmentId, thread.projectId),
            );
        },
      });
    },
    [newThreadContext, openMenu, openThread, projectOf, rowByKey, shelfOf, traversalKeys],
  );
  const commitRename = useCallback(
    (thread: ThreadRow, title: string) => {
      setRenaming(null);
      const resolution = resolveRenameCommit({ title, originalTitle: thread.title });
      if (resolution.action === "reject-empty") {
        toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
        return;
      }
      if (resolution.action === "noop") return;
      void updateThreadMetadata({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, title: resolution.title },
      }).then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Failed to rename thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
      });
    },
    [updateThreadMetadata],
  );

  const rowContext: RowContext = {
    activeKey,
    jumpLabelByKey,
    renaming,
    now,
    isMobile,
    primaryEnvironmentId,
    timestampFormat,
    projectByKey,
    projectTitleByKey,
    environmentLabelById,
    environmentMachineById,
    providerEntriesByEnvironment,
    onOpen: openThread,
    onMenu,
    onRenameStart: (thread) => setRenaming({ key: rowKey(thread), title: thread.title }),
    onRenameChange: (title) => setRenaming((current) => (current ? { ...current, title } : null)),
    onRenameCommit: commitRename,
    onRenameCancel: () => setRenaming(null),
    isMasterOpen,
    onToggleMaster: toggleMaster,
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && searchResults.length) {
      event.preventDefault();
      setActiveSearchIndex((selectedSearchIndex + 1) % searchResults.length);
    } else if (event.key === "ArrowUp" && searchResults.length) {
      event.preventDefault();
      setActiveSearchIndex((selectedSearchIndex - 1 + searchResults.length) % searchResults.length);
    } else if (event.key === "Enter" && searchResults[selectedSearchIndex]) {
      event.preventDefault();
      openThread(searchResults[selectedSearchIndex]);
    } else if (event.key === "Escape") changeSearchQuery("");
  };
  const onNewThread = (event?: MouseEvent) => {
    if (isMobile) setOpenMobile(false);
    if (projectGroupCount > 1 && !event?.shiftKey) {
      openCommandPalette({ open: "new-thread-in" });
      return;
    }
    void startNewThreadFromContext({
      activeDraftThread: newThreadContext.activeDraftThread,
      activeThread: newThreadContext.activeThread ?? undefined,
      defaultProjectRef: newThreadContext.defaultProjectRef,
      handleNewThread: newThreadContext.handleNewThread,
    });
  };
  // Mirrors the default sidebar: with several projects the primary label is
  // only the picker's shortcut, and chat.newLocal is the direct-create twin.
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.new") ??
    (projectGroupCount <= 1 ? shortcutLabelForCommand(keybindings, "chat.newLocal") : undefined);
  const newThreadInProjectShortcutLabel = shortcutLabelForCommand(keybindings, "chat.newLocal");

  const projectGroupsShown = workspace.activeProjects.filter((group) => projectOf(group));
  const anyProjectOpen = projectGroupsShown.some(isProjectOpen);
  const shelfProjectTitle = (group: ProjectGroup) => {
    const presentation = projectOf(group);
    return presentation ? (
      <SidebarSectionHeader
        icon={<ProjectFavicon project={presentation.project} className="size-4 shrink-0" />}
        label={presentation.title}
      />
    ) : null;
  };
  const renderShelfGroup = (group: ProjectGroup) => {
    const presentation = projectOf(group);
    return presentation ? (
      <ProjectGroupRows group={group} title={presentation.title} context={rowContext} />
    ) : null;
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
              newThreadShortcutLabel={newThreadShortcutLabel}
              newThreadInProjectShortcutLabel={newThreadInProjectShortcutLabel}
              showNewThreadInProjectHint={projectGroupCount > 1}
              searchInputRef={searchInputRef}
              searchQuery={searchQuery}
              onSearchQueryChange={changeSearchQuery}
              onSearchKeyDown={onSearchKeyDown}
              isSearching={Boolean(searchQuery.trim())}
              searchResultCount={searchResults.length}
              activeSearchResultIndex={selectedSearchIndex}
              onClearSearch={() => changeSearchQuery("")}
            />
          </SidebarGroup>
        }
      >
        <TooltipProvider delay={150} closeDelay={0} timeout={400}>
          {searchQuery.trim() ? (
            <SidebarGroup className="px-[var(--sidebar-content-inset)] py-2">
              <ul
                id="sidebar-thread-search-results"
                role="listbox"
                aria-label="Thread search results"
                className="flex flex-col gap-px"
              >
                {searchResults.map((thread, index) => (
                  <MasterThreadRow
                    key={rowKey(thread)}
                    thread={thread}
                    context={{
                      ...rowContext,
                      activeKey: null,
                      selectedKey: index === selectedSearchIndex ? rowKey(thread) : null,
                    }}
                  />
                ))}
              </ul>
            </SidebarGroup>
          ) : (
            <>
              <SidebarGroup className="px-[var(--sidebar-content-inset)] py-2">
                <ul role="list" className="flex flex-col gap-px">
                  <SidebarSectionHeader label="Pinned" />
                  {pinnedEntries.length === 0 ? (
                    <li className="list-none">
                      <p className="px-[var(--sidebar-row-content-inset)] py-2 text-xs text-muted-foreground">
                        Pin a Master to keep it here.
                      </p>
                    </li>
                  ) : (
                    pinnedEntries.map(({ thread, cards }) => (
                      <MasterBoard
                        key={rowKey(thread)}
                        board={{ master: thread, cards, structural: false }}
                        context={{ ...rowContext, onPinnedShelf: true }}
                      />
                    ))
                  )}
                </ul>
              </SidebarGroup>
              <SidebarGroup className="px-[var(--sidebar-content-inset)] py-2">
                <ul role="list" className="flex flex-col gap-px">
                  {/* The section header collapses or expands every project at once. */}
                  <SidebarSectionHeader
                    label="Projects"
                    {...(projectGroupsShown.length
                      ? {
                          toggle: {
                            expanded: anyProjectOpen,
                            onToggle: () => setProjectsOpen(projectGroupsShown, !anyProjectOpen),
                          },
                        }
                      : {})}
                  />
                  {workspace.activeProjects.map((group) => {
                    const projectKey = projectKeyOf(group);
                    const presentation = projectOf(group);
                    if (!presentation) return null;
                    const open = isProjectOpen(group);
                    // Collapsed, the header rolls up what its hidden rows need.
                    const attention = hiddenAttention(open, navigableRows(group));
                    return (
                      <Fragment key={projectKey}>
                        <SidebarSectionHeader
                          icon={
                            <ProjectFavicon
                              project={presentation.project}
                              className="size-4 shrink-0"
                            />
                          }
                          label={presentation.title}
                          detail={projectWorkSummary(group)}
                          status={attention ? <SidebarAttentionRollup status={attention} /> : null}
                          // Collapsed over the active thread: the header carries its highlight.
                          active={
                            !open &&
                            activeKey !== null &&
                            navigableRows(group).some((thread) => rowKey(thread) === activeKey)
                          }
                          toggle={{
                            expanded: open,
                            onToggle: () => setProjectsOpen([group], !open),
                          }}
                        />
                        {open ? (
                          <ProjectGroupRows
                            group={group}
                            title={presentation.title}
                            context={rowContext}
                          />
                        ) : null}
                      </Fragment>
                    );
                  })}
                </ul>
              </SidebarGroup>
              <ShelfGroup
                label="Snoozed"
                count={workspace.snoozedProjects.reduce(
                  (total, group) => total + group.visibleCount,
                  0,
                )}
                expanded={snoozedExpanded}
                onExpandedChange={(open) => setShelfOpen("snoozed", open)}
              >
                {workspace.snoozedProjects.map((group) => (
                  <Fragment key={projectKeyOf(group)}>
                    {shelfProjectTitle(group)}
                    {renderShelfGroup(group)}
                  </Fragment>
                ))}
              </ShelfGroup>
              <ShelfGroup
                label="Settled"
                count={settledRows.length}
                expanded={settledExpanded}
                onExpandedChange={(open) => setShelfOpen("settled", open)}
              >
                {settledRows.map((thread) => (
                  <MasterThreadRow
                    key={rowKey(thread)}
                    thread={thread}
                    context={{ ...rowContext, onSettledShelf: true }}
                  />
                ))}
              </ShelfGroup>
            </>
          )}
        </TooltipProvider>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
