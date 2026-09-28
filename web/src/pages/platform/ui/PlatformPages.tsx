// Pages for the platform features of the server: answering questions (public
// link), notifications, profile (Telegram, password, CLI token), automations
// with runs and playbooks, and the review of knowledge proposals.

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useSession } from "@/entities/session";
import {
  type Automation,
  RUN_STATUS,
  TRIGGER_NAME,
  useAutomations,
  useChannels,
  useNotifications,
  usePlaybooks,
  useProposal,
  useProposals,
  useRun,
  useRuns,
} from "@/entities/platform";
import { request } from "@/shared/api";
import { timeAgo, useTick } from "@/shared/lib";
import { Icon, Markdown, useToast } from "@/shared/ui";

function useAction() {
  const qc = useQueryClient();
  const toast = useToast();
  return async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast(ok);
      await qc.invalidateQueries();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };
}

// ------------------------------------------------------------------ answer page (public)

interface Questionnaire {
  id: number;
  task?: string;
  askedBy: string;
  status: string;
  questions: { n: number; text: string; why: string; options: string[]; answer?: string }[];
}

export function AnswerPage() {
  const [sp] = useSearchParams();
  const token = sp.get("token") ?? "";
  const [data, setData] = useState<{ questionnaire: Questionnaire; taskTitle?: string } | null>();
  const [error, setError] = useState<string>();
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [done, setDone] = useState(false);
  if (data === undefined && !error) {
    request<{ questionnaire: Questionnaire; taskTitle?: string }>("GET", `/api/answer/${encodeURIComponent(token)}`).then(setData, (e: Error) => setError(e.message));
  }
  const submit = async () => {
    try {
      const res = await request<{ questionnaire: Questionnaire; complete: boolean }>("POST", `/api/answer/${encodeURIComponent(token)}`, { answers });
      setData((d) => (d ? { ...d, questionnaire: res.questionnaire } : d));
      setDone(res.complete);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const qn = data?.questionnaire;
  return (
    <div className="auth-page">
      <div className="auth-card answer-card">
        <div className="brand">
          <span className="logo">
            <Icon.spark size={14} style={{ color: "#fff" }} />
          </span>
          <span className="name">genie</span>
        </div>
        {error && <div className="auth-error">{error}</div>}
        {!qn && !error && <div className="muted">Загрузка…</div>}
        {qn && (
          <>
            <h1>
              Вопросы от {qn.askedBy}
              {qn.task ? ` · ${qn.task}` : ""}
            </h1>
            {data?.taskTitle && <p className="auth-sub">{data.taskTitle}</p>}
            {done || qn.status !== "open" ? (
              <p className="auth-sub">{qn.status === "expired" ? "Срок ответа истёк." : "Спасибо! Ответы записаны в задачу, команда продолжит работу."}</p>
            ) : (
              <form
                className="auth-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                {qn.questions.map((q) => (
                  <div key={q.n} className="field">
                    <b style={{ color: "var(--text)" }}>
                      {q.n}. {q.text}
                    </b>
                    {q.why && <span>{q.why}</span>}
                    {q.answer ? (
                      <span className="answered">✓ {q.answer}</span>
                    ) : (
                      <>
                        {q.options.length > 0 && (
                          <div className="opts">
                            {q.options.map((o) => (
                              <button type="button" key={o} className={`chip${answers[q.n] === o ? " on" : ""}`} onClick={() => setAnswers({ ...answers, [q.n]: o })}>
                                {o}
                              </button>
                            ))}
                          </div>
                        )}
                        <textarea rows={2} value={answers[q.n] ?? ""} placeholder="Ваш ответ" onChange={(e) => setAnswers({ ...answers, [q.n]: e.target.value })} />
                      </>
                    )}
                  </div>
                ))}
                <button className="btn primary">Отправить ответы</button>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ notifications

export function NotificationsPage() {
  useTick();
  const q = useNotifications();
  const act = useAction();
  const navigate = useNavigate();
  const items = q.data?.items ?? [];
  return (
    <main className="main">
      <header className="topbar">
        <h1>Уведомления</h1>
        <span className="grow" />
        {(q.data?.unread ?? 0) > 0 && (
          <button type="button" className="btn" onClick={() => void act(() => request("POST", "/api/notifications/read", {}))}>
            Прочитать все
          </button>
        )}
      </header>
      <div className="scroll">
        {!items.length && <div className="empty">{q.isPending ? "Загрузка…" : "Уведомлений нет"}</div>}
        {items.map((n) => (
          <button
            type="button"
            key={n.id}
            className={`notif${n.readAt ? "" : " unread"}`}
            onClick={() =>
              void act(async () => {
                if (!n.readAt) await request("POST", "/api/notifications/read", { id: n.id });
                if (n.link) navigate(n.link);
              })
            }
          >
            <span className="notif-head">
              <b>{n.title}</b>
              <span className="when">{timeAgo(n.created)}</span>
            </span>
            {n.body && <span className="notif-body">{n.body}</span>}
          </button>
        ))}
      </div>
    </main>
  );
}

// ------------------------------------------------------------------ profile

export function ProfilePage() {
  const session = useSession().data;
  const channels = useChannels().data;
  const act = useAction();
  const [code, setCode] = useState<string>();
  const [token, setToken] = useState<string>();
  const [pw, setPw] = useState({ current: "", password: "" });
  const telegram = channels?.links.find((l) => l.channel === "telegram");
  const local = session?.mode === "local";
  return (
    <main className="main">
      <header className="topbar">
        <h1>Профиль</h1>
      </header>
      <div className="scroll settings">
        <section>
          <h2>{session?.user.name}</h2>
          <p className="muted">
            {session?.user.login}
            {session?.user.isAdmin ? " · администратор" : ""}
            {session?.user.email ? ` · ${session.user.email}` : ""}
          </p>
          {local && <p className="muted">Сервер работает без пользователей (локальный режим). Создайте учётку: genie user add &lt;login&gt; --admin --password-stdin</p>}
        </section>
        {!local && (
          <>
            <section>
              <h2>Telegram</h2>
              {!channels?.telegram ? (
                <p className="muted">Telegram не настроен на сервере (telegram.token в config.json).</p>
              ) : telegram ? (
                <p>
                  Чат привязан.{" "}
                  <button type="button" className="btn ghost" onClick={() => void act(() => request("DELETE", "/api/me/channels/telegram"), "Telegram отвязан")}>
                    Отвязать
                  </button>
                </p>
              ) : (
                <>
                  <p className="muted">Уведомления и вопросы от агентов будут приходить в Telegram, отвечать можно прямо там.</p>
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() =>
                      void act(async () => {
                        const r = await request<{ code: string; instructions: string }>("POST", "/api/me/channels/telegram/code");
                        setCode(r.instructions);
                      })
                    }
                  >
                    Привязать Telegram
                  </button>
                  {code && <p className="mono">{code}</p>}
                </>
              )}
            </section>
            <section>
              <h2>Пароль</h2>
              <form
                className="auth-form narrow"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(() => request("POST", "/api/auth/password", pw), "Пароль изменён — войдите снова");
                }}
              >
                <label className="field">
                  Текущий пароль
                  <input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
                </label>
                <label className="field">
                  Новый пароль
                  <input type="password" minLength={8} value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} />
                </label>
                <button className="btn">Сменить пароль</button>
              </form>
            </section>
            <section>
              <h2>Токен для CLI</h2>
              <p className="muted">Для `genie agent …` и скриптов: GENIE_URL и GENIE_TOKEN.</p>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  void act(async () => {
                    const r = await request<{ token: string }>("POST", "/api/auth/tokens", { label: "web" });
                    setToken(r.token);
                  })
                }
              >
                Выпустить токен
              </button>
              {token && <p className="mono break">{token}</p>}
            </section>
          </>
        )}
      </div>
    </main>
  );
}

// ------------------------------------------------------------------ automations

export function AutomationsPage() {
  useTick();
  const rules = useAutomations();
  const playbooks = usePlaybooks();
  const [selected, setSelected] = useState<number>();
  const [editing, setEditing] = useState<{ id?: number; text: string }>();
  const act = useAction();
  const installed = new Set((rules.data ?? []).map((r) => r.name));
  const current = rules.data?.find((r) => r.id === selected);
  return (
    <main className="main">
      <header className="topbar">
        <h1>Автоматизации</h1>
        <span className="grow" />
        <button type="button" className="btn primary" onClick={() => setEditing({ text: JSON.stringify(EMPTY_RULE, null, 2) })}>
          <Icon.plus size={13} />
          <span className="d-only">Новое правило</span>
        </button>
      </header>
      <div className="scroll settings">
        <section>
          <h2>Правила</h2>
          {!rules.data?.length && <p className="muted">Правил пока нет — начните с готового плейбука ниже.</p>}
          {rules.data?.map((r) => (
            <RuleRow key={r.id} rule={r} open={selected === r.id} onOpen={() => setSelected(selected === r.id ? undefined : r.id)} onEdit={() => setEditing({ id: r.id, text: JSON.stringify(r.spec, null, 2) })} />
          ))}
        </section>
        {current && <Runs automation={current.id} />}
        <section>
          <h2>Плейбуки</h2>
          {playbooks.data?.map((p) => (
            <div className="rule" key={p.id}>
              <span className="grow">
                <b>{p.title}</b>
                <span className="muted"> · {String((p.spec as { name?: string }).name ?? "")}</span>
              </span>
              <button
                type="button"
                className="btn"
                disabled={installed.has(String((p.spec as { name?: string }).name))}
                onClick={() => void act(() => request("POST", `/api/automations/playbooks/${p.id}`), "Правило добавлено")}
              >
                {installed.has(String((p.spec as { name?: string }).name)) ? "Добавлен" : "Добавить"}
              </button>
            </div>
          ))}
        </section>
      </div>
      {editing && <RuleEditor initial={editing} onClose={() => setEditing(undefined)} />}
    </main>
  );
}

const EMPTY_RULE = {
  name: "Новое правило",
  on: { event: "task.status_changed", where: { to: "done" } },
  steps: [{ id: "tell", notify: { to: ["task.author"], title: "{{ event.task.id }} готова", text: "{{ event.task.title }}" } }],
};

function RuleRow({ rule, open, onOpen, onEdit }: { rule: Automation; open: boolean; onOpen: () => void; onEdit: () => void }) {
  const act = useAction();
  return (
    <div className={`rule${open ? " on" : ""}`}>
      <button type="button" className="grow rule-main" onClick={onOpen}>
        <b>{rule.name}</b>
        <span className="muted">
          {" "}
          · {TRIGGER_NAME[rule.trigger] ?? rule.trigger}
          {rule.dryRun ? " · пробный режим" : ""}
          {rule.lastRun ? ` · последний запуск ${RUN_STATUS[rule.lastRun.status] ?? rule.lastRun.status} ${timeAgo(rule.lastRun.started)}` : " · ещё не запускалось"}
        </span>
      </button>
      {rule.trigger === "manual" && (
        <button type="button" className="btn" onClick={() => void act(() => request("POST", `/api/automations/${rule.id}/run`, {}), "Запущено")}>
          Запустить
        </button>
      )}
      <button type="button" className="btn ghost" onClick={onEdit}>
        Изменить
      </button>
      <label className="toggle">
        <input type="checkbox" checked={rule.enabled} onChange={(e) => void act(() => request("POST", `/api/automations/${rule.id}/enabled`, { enabled: e.target.checked }))} />
        {rule.enabled ? "вкл" : "выкл"}
      </label>
    </div>
  );
}

function RuleEditor({ initial, onClose }: { initial: { id?: number; text: string }; onClose: () => void }) {
  const [text, setText] = useState(initial.text);
  const [error, setError] = useState<string>();
  const qc = useQueryClient();
  const save = async () => {
    try {
      const spec = JSON.parse(text);
      if (initial.id) await request("PUT", `/api/automations/${initial.id}`, { spec });
      else await request("POST", "/api/automations", { spec });
      await qc.invalidateQueries();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const remove = async () => {
    if (!initial.id) return;
    await request("DELETE", `/api/automations/${initial.id}`);
    await qc.invalidateQueries();
    onClose();
  };
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="mh">
          {initial.id ? "Правило (JSON)" : "Новое правило (JSON)"}
          <span className="grow" />
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <Icon.close />
          </button>
        </div>
        <div className="mb">
          <p className="muted" style={{ margin: 0 }}>
            Триггер: <code>event</code> (+ <code>where</code>), <code>schedule</code> (cron, <code>tz</code>), <code>manual</code>, <code>webhook</code>. Шаги: task.status, task.comment, task.create,
            task.update, task.get, notify, agent, team, ask, wait, wake_orchestrator, changelog.add, release, http. Подстановки: <code>{"{{ event.task.id }}"}</code>,{" "}
            <code>{"{{ steps.<id>.output.… }}"}</code>.
          </p>
          <textarea className="mono code-edit" rows={22} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
          {error && <div className="auth-error">{error}</div>}
        </div>
        <div className="mf">
          {initial.id && (
            <button type="button" className="btn danger" onClick={() => void remove()}>
              Удалить
            </button>
          )}
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="button" className="btn primary" onClick={() => void save()}>
            Сохранить
          </button>
        </div>
      </div>
    </div>
  );
}

function Runs({ automation }: { automation: number }) {
  const runs = useRuns(automation);
  const [open, setOpen] = useState<number>();
  const run = useRun(open);
  const act = useAction();
  return (
    <section>
      <h2>Запуски</h2>
      {!runs.data?.length && <p className="muted">Запусков пока не было.</p>}
      {runs.data?.map((r) => (
        <div key={r.id}>
          <button type="button" className={`rule rule-main${open === r.id ? " on" : ""}`} onClick={() => setOpen(open === r.id ? undefined : r.id)}>
            <span className={`run-dot ${r.status}`} />
            <span className="grow">
              #{r.id} · {RUN_STATUS[r.status] ?? r.status} · {timeAgo(r.started)}
              {r.error ? <span className="muted"> · {r.error}</span> : null}
            </span>
          </button>
          {open === r.id && run.data && (
            <div className="run-steps">
              {run.data.steps.map((s) => (
                <details key={s.id}>
                  <summary>
                    <span className={`run-dot ${s.status}`} /> {s.stepId} <span className="muted">({s.kind}) · {RUN_STATUS[s.status] ?? s.status}</span>
                    {s.error && <span className="auth-error"> · {s.error}</span>}
                  </summary>
                  <pre className="view">{JSON.stringify({ input: s.input, output: s.output, wait: s.wait }, null, 2)}</pre>
                </details>
              ))}
              {["queued", "running", "waiting"].includes(run.data.status) && (
                <button type="button" className="btn ghost" onClick={() => void act(() => request("POST", `/api/runs/${r.id}/cancel`), "Отменено")}>
                  Отменить запуск
                </button>
              )}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

// ------------------------------------------------------------------ knowledge proposals

/** Page body with the frontmatter shown apart, so the comparison reads like the page. */
function PageBody({ text }: { text: string }) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  return (
    <>
      {m && <pre className="view frontmatter">{m[1]}</pre>}
      <Markdown text={m ? text.slice(m[0].length) : text} />
    </>
  );
}

export function ProposalsPage() {
  useTick();
  const [sp, setSp] = useSearchParams();
  const selected = Number(sp.get("proposal") ?? "") || undefined;
  const list = useProposals();
  const one = useProposal(selected);
  const act = useAction();
  const decide = (verb: "approve" | "reject", force = false) =>
    act(async () => {
      await request("POST", `/api/docs/proposals/${selected}/${verb}`, { force });
      setSp({});
    }, verb === "approve" ? "Правка опубликована" : "Предложение отклонено");
  return (
    <main className="main">
      <header className="topbar">
        <h1>Предложения в базу знаний</h1>
        <span className="grow" />
        <Link className="btn ghost" to="/docs">
          К документации
        </Link>
      </header>
      <div className="scroll settings">
        {!list.data?.length && <div className="empty">Открытых предложений нет</div>}
        {list.data?.map((p) => (
          <button type="button" key={p.id} className={`rule rule-main${selected === p.id ? " on" : ""}`} onClick={() => setSp({ proposal: String(p.id) })}>
            <span className="grow">
              <b className="mono">{p.path}</b>
              <span className="muted">
                {" "}
                · {p.author}
                {p.authorKind === "agent" ? " (агент)" : ""}
                {p.task ? ` · ${p.task}` : ""} · {timeAgo(p.created)}
              </span>
            </span>
          </button>
        ))}
        {one.data && (
          <section className="proposal">
            <h2>
              #{one.data.proposal.id} · {one.data.proposal.path}
            </h2>
            {one.data.proposal.note && <p className="muted">{one.data.proposal.note}</p>}
            {one.data.owners.length > 0 && <p className="muted">Владельцы раздела: {one.data.owners.join(", ")}</p>}
            <div className="compare">
              <div>
                <h3>Сейчас</h3>
                {one.data.current ? <PageBody text={one.data.current} /> : <p className="muted">Новая страница</p>}
              </div>
              <div>
                <h3>Предложено</h3>
                <PageBody text={one.data.proposal.content ?? ""} />
              </div>
            </div>
            <div className="actions">
              <button type="button" className="btn primary" onClick={() => void decide("approve")}>
                Опубликовать
              </button>
              <button type="button" className="btn" onClick={() => void decide("reject")}>
                Отклонить
              </button>
              <button type="button" className="btn ghost" onClick={() => void decide("approve", true)} title="Если страница изменилась после предложения">
                Опубликовать поверх изменений
              </button>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
