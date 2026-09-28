import { NavLink, useLocation } from "react-router";
import { BookIcon, useDocsTree } from "@/entities/doc";
import { useMeta } from "@/entities/project";
import { useLogout, useSession, useSwitchProject } from "@/entities/session";
import { useNotifications, useProposals } from "@/entities/platform";
import { EpicIcon, inTaskViews, StageBars, StatusIcon, stageOf, type ViewId, VIEWS, useTasks } from "@/entities/task";
import { useTeams } from "@/entities/team";
import { timeAgo, useTick } from "@/shared/lib";
import { Icon } from "@/shared/ui";

const NAV: { id: ViewId; icon: "inbox" | "needs_owner" | "in_progress" | "refining" | "done" }[] = [
  { id: "inbox", icon: "inbox" },
  { id: "decisions", icon: "needs_owner" },
  { id: "active", icon: "in_progress" },
  { id: "prep", icon: "refining" },
  { id: "done", icon: "done" },
];

export function Sidebar({ onNew, online }: { onNew: () => void; online: boolean }) {
  useTick();
  const meta = useMeta().data;
  const session = useSession().data;
  const switchProject = useSwitchProject();
  const logout = useLogout();
  const unread = useNotifications().data?.unread ?? 0;
  const proposals = useProposals().data?.length ?? 0;
  const teams = useTeams().data?.filter((t) => t.state === "active") ?? [];
  const { search, pathname } = useLocation();
  const tasks = useTasks().data;
  const docs = useDocsTree().data;
  const docsCount = docs?.pages.length ?? 0;
  const count = (id: ViewId) =>
    tasks ? tasks.filter((t) => inTaskViews(t) && VIEWS[id].statuses.includes(t.status)).length : VIEWS[id].statuses.reduce((n, s) => n + (meta?.counts[s] ?? 0), 0);
  const openEpics = tasks?.filter((t) => t.type === "epic" && t.status !== "done" && t.status !== "cancelled").length ?? 0;

  return (
    <nav className="sidebar" aria-label="Навигация">
      <div className="brand">
        <span className="logo">
          <Icon.spark size={14} style={{ color: "#fff" }} />
        </span>
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span className="name">{meta?.project ?? "genie"}</span>
          <span className="sub">genie · {session?.mode === "users" ? session.user.name : "локальный режим"}</span>
        </span>
      </div>
      {session && session.projects.length > 1 && (
        <label className="project-switch">
          <select aria-label="Проект" value={session.project ?? ""} onChange={(e) => void switchProject(e.target.value)}>
            {session.projects.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
                {p.role === "viewer" ? " (чтение)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      <button type="button" className="new-task" onClick={onNew}>
        <Icon.plus size={14} />
        <span className="grow" style={{ textAlign: "left" }}>
          Новая задача
        </span>
        <kbd>C</kbd>
      </button>

      {NAV.map((n) => {
        const c = count(n.id);
        return (
          <NavLink key={n.id} to={{ pathname: `/${n.id}`, search: keepLayout(search) }} className={({ isActive }) => `nav-item${isActive ? " on" : ""}`}>
            <StatusIcon status={n.icon} size={15} />
            <span className="grow">{VIEWS[n.id].name}</span>
            {n.id === "decisions" && c > 0 ? <span className="count alert">{c}</span> : <span className="count">{c || ""}</span>}
          </NavLink>
        );
      })}

      <NavLink to="/epics" className={({ isActive }) => `nav-item${isActive || pathname.startsWith("/epic/") ? " on" : ""}`}>
        <EpicIcon size={15} />
        <span className="grow">Эпики</span>
        <span className="count">{openEpics || ""}</span>
      </NavLink>

      <NavLink to={{ pathname: "/docs", search: keepLayout(search) }} className={({ isActive }) => `nav-item${isActive || pathname.startsWith("/docs") ? " on" : ""}`}>
        <BookIcon size={15} />
        <span className="grow">Документация</span>
        <span className="count">{docs ? docsCount : ""}</span>
      </NavLink>

      <NavLink to="/docs/proposals" className={({ isActive }) => `nav-item${isActive ? " on" : ""}`}>
        <Icon.check size={15} />
        <span className="grow">Предложения</span>
        {proposals > 0 ? <span className="count alert">{proposals}</span> : <span className="count" />}
      </NavLink>

      <NavLink to="/automations" className={({ isActive }) => `nav-item${isActive ? " on" : ""}`}>
        <Icon.spark size={15} />
        <span className="grow">Автоматизации</span>
      </NavLink>

      <NavLink to="/notifications" className={({ isActive }) => `nav-item${isActive ? " on" : ""}`}>
        <Icon.send size={15} />
        <span className="grow">Уведомления</span>
        {unread > 0 ? <span className="count alert">{unread}</span> : <span className="count" />}
      </NavLink>

      {teams.length > 0 && <div className="nav-section">Команды</div>}
      {teams.map((t) => {
        const status = t.taskInfo?.status;
        const working = t.members.some((m) => m.activity === "working");
        const waiting = status === "needs_owner";
        return (
          <NavLink key={t.id} to={`/team/${encodeURIComponent(t.id)}`} className={({ isActive }) => `team-link${isActive ? " on" : ""}`}>
            <span className="top">
              {waiting ? <span className="dot-amber" /> : working ? <span className="spin" /> : <span className="dot-idle" />}
              <span className="mono" style={{ color: "var(--text)" }}>
                {t.id}
              </span>
              <span style={{ color: waiting ? "var(--amber)" : "var(--muted)" }}>{waiting ? "ждёт вас" : status ? statusShort(status) : ""}</span>
              <span className="when">{timeAgo(t.created)}</span>
            </span>
            <span className="bars">
              <StageBars stage={status ? stageOf(status) : 0} amber={waiting} />
            </span>
          </NavLink>
        );
      })}

      <div className="side-foot">
        <span className={`live${online ? "" : " off"}`}>
          <i />
          {online ? "Живое обновление" : "Нет связи с сервером"}
        </span>
        <span className="mono">{meta?.tailnet ? `${meta.tailnet}` : location.host}</span>
        <NavLink to="/profile" className="logout">
          Профиль
        </NavLink>
        {session?.mode === "users" && (
          <button type="button" className="logout" onClick={() => void logout()}>
            Выйти ({session.user.login})
          </button>
        )}
      </div>
    </nav>
  );
}

function statusShort(s: string): string {
  return ({ inbox: "входящие", draft: "черновик", refining: "уточнение", ready: "готово", in_progress: "в работе", changes_requested: "доработка", review: "ревью", approved: "одобрено", done: "принято" } as Record<string, string>)[s] ?? s;
}

export function keepLayout(search: string): string {
  const p = new URLSearchParams(search);
  const layout = p.get("layout");
  return layout ? `?layout=${layout}` : "";
}

