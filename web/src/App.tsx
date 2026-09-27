import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createBrowserRouter, Navigate, Outlet, useLocation, useNavigate, useOutletContext, useSearchParams } from "react-router";
import { CommandPalette, type PaletteActions } from "./components/CommandPalette.tsx";
import { NewTaskDialog } from "./components/NewTaskDialog.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { TaskDetail } from "./components/TaskDetail.tsx";
import { isTyping, TasksPage, useTeamMap } from "./components/TasksPage.tsx";
import { TeamView } from "./components/TeamView.tsx";
import { useLiveUpdates, useTasks } from "./lib/api.ts";
import type { ViewId } from "./lib/model.ts";

function Shell() {
  const online = useLiveUpdates();
  const navigate = useNavigate();
  const location = useLocation();
  const [sp, setSp] = useSearchParams();
  const [dialog, setDialog] = useState<"new" | "palette" | undefined>();
  const searchRef = useRef<HTMLInputElement>(null);
  const teams = useTeamMap();
  const tasks = useTasks().data;
  const teamRoute = location.pathname.startsWith("/team/");
  const openTaskId = teamRoute ? undefined : (sp.get("task") ?? undefined);
  const openTask = tasks?.find((t) => t.id === openTaskId);

  const closeTask = useCallback(() => {
    const next = new URLSearchParams(sp);
    next.delete("task");
    setSp(next);
  }, [sp, setSp]);

  const actions: PaletteActions = useMemo(
    () => ({
      newTask: () => setDialog("new"),
      go: (v: ViewId) => navigate({ pathname: `/${v}`, search: sp.get("layout") ? `?layout=${sp.get("layout")}` : "" }),
      layout: (l) => navigate({ pathname: teamRoute ? "/active" : location.pathname, search: `?layout=${l}` }),
      openTask: (id) => navigate({ pathname: teamRoute ? "/active" : location.pathname, search: `?${new URLSearchParams({ ...(sp.get("layout") ? { layout: sp.get("layout")! } : {}), task: id })}` }),
      openTeam: (id) => navigate(`/team/${encodeURIComponent(id)}`),
    }),
    [navigate, sp, location.pathname, teamRoute],
  );

  // Global shortcuts (Linear-style): C, /, ⌘K, Esc, G then I/D/A/P/C
  const gPending = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setDialog("palette");
        return;
      }
      if (dialog) return;
      if (e.key === "Escape" && openTaskId && !isTyping(e)) {
        closeTask();
        return;
      }
      if (isTyping(e)) return;
      if (Date.now() - gPending.current < 1200) {
        const map: Record<string, ViewId> = { i: "inbox", d: "decisions", a: "active", p: "prep", c: "done" };
        gPending.current = 0;
        if (map[e.key]) {
          actions.go(map[e.key]);
          e.preventDefault();
          return;
        }
      }
      if (e.key === "g") gPending.current = Date.now();
      else if (e.key === "c") {
        e.preventDefault();
        setDialog("new");
      } else if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog, openTaskId, closeTask, actions]);

  const cls = teamRoute ? "app team-view" : openTaskId ? "app with-detail" : "app";
  return (
    <div className={cls}>
      <Sidebar onNew={() => setDialog("new")} online={online} />
      <Outlet context={{ onNew: () => setDialog("new"), searchRef }} />
      {openTaskId && <TaskDetail key={openTaskId} id={openTaskId} team={openTask?.team ? teams.get(openTask.team) : undefined} onClose={closeTask} />}
      {dialog === "new" && <NewTaskDialog onClose={() => setDialog(undefined)} onCreated={(id) => (setDialog(undefined), navigate(`/inbox?task=${encodeURIComponent(id)}`))} />}
      {dialog === "palette" && <CommandPalette onClose={() => setDialog(undefined)} actions={actions} />}
    </div>
  );
}

function TasksRoute() {
  const ctx = useOutletContext<{ onNew: () => void; searchRef: React.RefObject<HTMLInputElement | null> }>();
  return <TasksPage onNew={ctx.onNew} searchRef={ctx.searchRef} />;
}

export const router = createBrowserRouter([
  {
    path: "/",
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to="/active" replace /> },
      { path: "team/:teamId", element: <TeamView /> },
      { path: ":view", element: <TasksRoute /> },
    ],
  },
]);
