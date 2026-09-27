import { NavLink, useLocation } from "react-router";
import { useMeta } from "@/entities/project";
import { StageBars, StatusIcon, stageOf, type ViewId, VIEWS } from "@/entities/task";
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
  const teams = useTeams().data?.filter((t) => t.state === "active") ?? [];
  const { search } = useLocation();
  const count = (id: ViewId) => VIEWS[id].statuses.reduce((n, s) => n + (meta?.counts[s] ?? 0), 0);

  return (
    <nav className="sidebar" aria-label="Навигация">
      <div className="brand">
        <span className="logo">
          <Icon.spark size={14} style={{ color: "#fff" }} />
        </span>
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span className="name">{meta?.project ?? "genie"}</span>
          <span className="sub">genie · трекер репозитория</span>
        </span>
      </div>
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

