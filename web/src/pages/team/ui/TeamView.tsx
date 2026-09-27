import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { Avatar } from "@/entities/member";
import { StageBars, STAGES, stageOf, STATUS_NAME } from "@/entities/task";
import { type Mail, type TeamDetail, useSendMail, useTeam } from "@/entities/team";
import { clock, dayLabel, timeAgo, useTick } from "@/shared/lib";
import { Icon, useToast } from "@/shared/ui";

/** One chat entry: broadcast rows (one per recipient) and kickoffs are merged. */
interface Entry {
  key: string;
  at: string;
  kind: "system" | "agent" | "mine";
  from: string;
  fromRole: string;
  to: string[];
  text: string;
  urgent: boolean;
  delivered: boolean;
  title?: string;
}

function toEntries(mail: Mail[]): Entry[] {
  const out: Entry[] = [];
  for (const m of mail) {
    const last = out.at(-1);
    const kind: Entry["kind"] = m.kind === "kickoff" || m.kind === "system" ? "system" : m.fromRole === "human" ? "mine" : "agent";
    const sameSend = last && last.from === m.from && last.at.slice(0, 19) === m.at.slice(0, 19) && (last.text === m.text || (kind === "system" && last.kind === "system"));
    if (sameSend && last) {
      last.to.push(m.to);
      last.delivered &&= !!m.deliveredAt;
      continue;
    }
    out.push({
      key: String(m.id),
      at: m.at,
      kind,
      from: m.from.replace(/^owner \((.*)\)$/, "$1"),
      fromRole: m.fromRole,
      to: [m.to],
      text: m.text,
      urgent: !!m.urgent,
      delivered: !!m.deliveredAt,
      title: m.kind === "kickoff" ? "Команда запущена" : undefined,
    });
  }
  return out;
}

function recipients(to: string[], team: TeamDetail): string {
  const everyone = team.members.length + 1;
  if (to.length >= everyone - 1 && to.length > 1) return "всем";
  return to.map((x) => (x === "orchestrator" ? "orchestrator" : x)).join(", ");
}

const EVENT_TEXT: Record<string, (e: Record<string, unknown>) => string> = {
  team_created: () => "команда создана",
  member_started: (e) => `${e.member} запущен`,
  member_stopped: (e) => `${e.member} остановлен`,
  member_added: (e) => `добавлен ${String(e.member).split(":")[0]}`,
  status: (e) => `${e.member}: ${e.status}`,
  task_status: (e) => `${e.task} → ${STATUS_NAME[e.status as keyof typeof STATUS_NAME] ?? e.status}`,
  agent_error: (e) => `${e.member}: ошибка модели`,
  blocked: (e) => `${e.task} заблокирована: ${e.reason}`,
  team_stopped: () => "команда остановлена",
  launch_failed: () => "не удалось запустить участников",
};

export function TeamView() {
  useTick(15_000);
  const { teamId } = useParams();
  const q = useTeam(teamId);
  const send = useSendMail();
  const toast = useToast();
  const [to, setTo] = useState("all");
  const [draft, setDraft] = useState("");
  const chatRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const team = q.data;
  const entries = useMemo(() => (team ? toEntries(team.mail) : []), [team]);

  useEffect(() => setTo("all"), [teamId]);
  useLayoutEffect(() => {
    const el = chatRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries.length, teamId]);

  if (q.isPending) return <main className="main"><div className="empty">Загрузка…</div></main>;
  if (q.isError || !team) return <main className="main"><div className="empty">Команда не найдена</div></main>;

  const status = team.taskInfo?.status;
  const stage = status ? stageOf(status) : 0;
  const working = team.members.filter((m) => m.activity === "working");
  const active = team.state === "active";

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    stick.current = true;
    send.mutate({ team: team.id, to, text }, { onSuccess: () => setDraft(""), onError: (e) => toast(`Не отправлено: ${e.message}`, "error") });
  };

  let lastDay = "";

  return (
    <>
      <main className="main">
        <header className="team-head">
          <div className="line">
            <Link to="/active" className="icon-btn m-only" aria-label="Назад">
              <Icon.back />
            </Link>
            {active ? status === "needs_owner" ? <span className="dot-amber" /> : working.length ? <span className="spin lg" /> : <span className="dot-idle" /> : <Icon.check style={{ color: "var(--muted)" }} />}
            <h1>Команда {team.id}</h1>
            {status && <span className="status-tag">{active ? STATUS_NAME[status] : "остановлена"}</span>}
            {team.taskInfo && (
              <Link className="task d-only" to={`/active?task=${encodeURIComponent(team.taskInfo.id)}`}>
                {team.taskInfo.title}
              </Link>
            )}
            <span className="grow" />
            {team.worktree && <span className="mono muted d-only" style={{ fontSize: 12 }}>⎇ {team.worktree.branch}</span>}
            <span className="muted" style={{ fontSize: 12 }}>
              {timeAgo(team.created)}
            </span>
          </div>
          <StageBars stage={stage} big amber={status === "needs_owner"} />
          <div className="stage-labels d-only">
            {STAGES.map((s, i) => (
              <span key={s} className={i === stage - 1 ? "on" : ""}>
                {s}
              </span>
            ))}
          </div>
        </header>

        <div className="chat" ref={chatRef} role="log" aria-label="Чат команды" onScroll={(e) => (stick.current = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 60)}>
          <div className="inner">
            {entries.map((m, i) => {
              const day = dayLabel(m.at);
              const showDay = day !== lastDay;
              lastDay = day;
              const prev = entries[i - 1];
              const next = entries[i + 1];
              const same = (a?: Entry) => !!a && a.kind === m.kind && a.from === m.from && a.to.join() === m.to.join() && dayLabel(a.at) === day;
              const cont = same(prev) && !showDay;
              const tailless = same(next);
              return (
                <Fragment key={m.key}>
                  {showDay && <div className="day">{day}</div>}
                  {m.kind === "system" ? (
                    <div className="sys">
                      <div>
                        <b>
                          {m.title ?? `${m.from} → ${recipients(m.to, team)}`} · {clock(m.at)}
                        </b>
                        {m.title ? `Участники: ${m.to.join(", ")}` : m.text}
                      </div>
                    </div>
                  ) : m.kind === "mine" ? (
                    <div className={`msg mine${cont ? " cont" : ""}${tailless ? " tailless" : ""}`}>
                      <div className="col2">
                        {!cont && (
                          <span className="who">
                            <span className="n" style={{ color: "#c3c8fa" }}>
                              Вы
                            </span>
                            <span className="m">
                              → {recipients(m.to, team)} · {clock(m.at)}
                            </span>
                          </span>
                        )}
                        <div className="bubble">{m.text}</div>
                        {!tailless && <span className="receipt">{m.delivered ? "получено" : "отправлено"}</span>}
                      </div>
                    </div>
                  ) : (
                    <div className={`msg${cont ? " cont" : ""}${tailless ? " tailless" : ""}${m.urgent ? " urgent" : ""}`}>
                      <span className="slot">{!tailless && <Avatar role={m.fromRole} name={m.from} size="lg" />}</span>
                      <div className="col2">
                        {!cont && (
                          <span className="who">
                            <span className={`n c-${m.fromRole}`}>{m.from}</span>
                            <span className="m">
                              → {recipients(m.to, team)} · {clock(m.at)}
                              {m.urgent ? " · срочно" : ""}
                            </span>
                          </span>
                        )}
                        <div className="bubble">{m.text}</div>
                      </div>
                    </div>
                  )}
                </Fragment>
              );
            })}
            {!entries.length && <div className="empty">Сообщений пока нет</div>}
            {active && working.length > 0 && (
              <div className="typing" aria-live="polite">
                <span className="slot" style={{ width: 30, display: "flex", justifyContent: "center" }}>
                  <Avatar role={working[0].role} name={working[0].name} size="lg" />
                </span>
                <span className="dots">
                  <span />
                  <span />
                  <span />
                </span>
                {working.map((w) => w.name).join(", ")} {working.length > 1 ? "работают" : "работает"}
              </div>
            )}
          </div>
        </div>

        {active && (
          <form
            className="chat-form"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="to" role="group" aria-label="Кому">
              Кому
              {[{ name: "all", role: "" }, ...team.members.map((m) => ({ name: m.name, role: m.role })), { name: "orchestrator", role: "orchestrator" }].map((r) => (
                <button key={r.name} type="button" className={`chip${to === r.name ? " on" : ""}`} aria-pressed={to === r.name} onClick={() => setTo(r.name)}>
                  <i className={r.role ? `r-${r.role}` : ""} style={r.role ? undefined : { background: "var(--text-2)" }} />
                  {r.name === "all" ? "Всем" : r.name}
                </button>
              ))}
            </div>
            <div className="chat-input">
              <textarea
                aria-label="Сообщение"
                rows={1}
                value={draft}
                placeholder={to === "all" ? "Сообщение всей команде" : `Сообщение для ${to}`}
                onChange={(e) => {
                  setDraft(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = `${Math.min(140, e.target.scrollHeight)}px`;
                }}
                onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && (e.preventDefault(), submit())}
              />
              <span className="muted d-only" style={{ fontSize: 11, paddingBottom: 9 }}>
                ⌘↵
              </span>
              <button type="submit" className="send" aria-label="Отправить" disabled={!draft.trim() || send.isPending}>
                <Icon.send size={16} style={{ color: "#fff" }} />
              </button>
            </div>
          </form>
        )}
      </main>

      <aside className="team-aside" aria-label="Участники и события">
        <div className="hd">Участники</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "10px 0 4px" }}>
          {team.members.map((m) => (
            <div key={m.name} className={`mcard${m.activity === "working" && active ? " working" : ""}`}>
              <Avatar role={m.role} name={m.name} activity={active ? m.activity : undefined} state={m.state} size="lg" />
              <span className="info">
                <span className="nm">
                  <b>{m.name}</b>
                  {m.activity === "error" ? <span className="e">ошибка</span> : m.activity === "working" && active ? <span className="w">работает</span> : <span>{m.state === "stopped" ? "остановлен" : "ждёт"}</span>}
                  {team.pending[m.name] ? <span style={{ color: "var(--amber)" }}>✉ {team.pending[m.name]}</span> : null}
                </span>
                <span className="model">
                  {m.model?.replace(/^[^/]+\//, "") ?? "модель по умолчанию"}
                  {m.thinking ? ` · ${m.thinking}` : ""}
                </span>
                <span className="st">{m.status}</span>
              </span>
            </div>
          ))}
        </div>
        <div className="nav-section" style={{ margin: "12px 18px 8px" }}>
          События
        </div>
        <ol className="events">
          {[...team.log]
            .filter((e) => e.event !== "mail")
            .reverse()
            .slice(0, 40)
            .map((e, i) => (
              <li key={i}>
                <span className="t">{clock(e.at)}</span>
                <span>{(EVENT_TEXT[e.event] ?? (() => e.event))(e)}</span>
              </li>
            ))}
        </ol>
      </aside>
    </>
  );
}
