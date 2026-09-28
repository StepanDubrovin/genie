// Pages for the platform features of the server: answering questions (public
// link), notifications, profile (Telegram, password, CLI token), automations
// with runs and playbooks, and the review of knowledge proposals.

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useSession } from "@/entities/session";
import {
  type Automation,
  type Notification,
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
  const closed = done || (qn && qn.status !== "open");
  return (
    <div className="auth-page">
      <div className="answer">
        <span className="logo-mark lg">
          <Icon.mark size={22} />
        </span>
        {error && <div className="auth-error">{error}</div>}
        {!qn && !error && <div className="muted">Загрузка…</div>}
        {qn && (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span className="ctx">
                {qn.task ? <span className="mono">{qn.task}</span> : "genie"} · спрашивает {qn.askedBy}
              </span>
              <h1>{closed ? "Ответы получены" : "Нужны ваши ответы"}</h1>
              {data?.taskTitle && <p className="lead">{data.taskTitle}</p>}
            </div>
            {closed ? (
              <div className="done">
                {qn.status === "expired" ? "Срок ответа истёк — вопрос передан владельцу проекта." : "Спасибо! Ответы записаны в задачу, команда продолжит работу."}
              </div>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                {qn.questions.map((q) => (
                  <fieldset key={q.n}>
                    <legend>
                      <span className="n">{q.n}.</span> {q.text}
                    </legend>
                    {q.why && <span className="why">{q.why}</span>}
                    {q.answer ? (
                      <span className="answered">
                        <Icon.check size={13} />
                        {q.answer}
                      </span>
                    ) : (
                      <>
                        {q.options.map((o) => (
                          <label key={o} className={`opt${answers[q.n] === o ? " on" : ""}`}>
                            <input type="radio" name={`q${q.n}`} checked={answers[q.n] === o} onChange={() => setAnswers({ ...answers, [q.n]: o })} />
                            {o}
                          </label>
                        ))}
                        <textarea
                          rows={q.options.length ? 2 : 3}
                          aria-label={`Ответ на вопрос ${q.n}`}
                          value={q.options.includes(answers[q.n] ?? "") ? "" : (answers[q.n] ?? "")}
                          placeholder={q.options.length ? "Или свой ответ" : "Ваш ответ"}
                          onChange={(e) => setAnswers({ ...answers, [q.n]: e.target.value })}
                        />
                      </>
                    )}
                  </fieldset>
                ))}
                <button className="btn primary submit">Отправить ответы</button>
                <span className="note">Вход не нужен — ссылка работает, пока вопрос открыт</span>
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
  const days: { day: string; items: Notification[] }[] = [];
  for (const n of items) {
    const day = dayName(n.created);
    if (days.at(-1)?.day !== day) days.push({ day, items: [] });
    days.at(-1)!.items.push(n);
  }
  return (
    <main className="main">
      <header className="topbar">
        <h1>Уведомления</h1>
        {(q.data?.unread ?? 0) > 0 && <span className="sub">{q.data?.unread} непрочитанных</span>}
        <span className="grow" />
        {(q.data?.unread ?? 0) > 0 && (
          <button type="button" className="btn" onClick={() => void act(() => request("POST", "/api/notifications/read", {}))}>
            Прочитать все
          </button>
        )}
      </header>
      <div className="scroll">
        {!items.length && <div className="empty">{q.isPending ? "Загрузка…" : "Уведомлений нет"}</div>}
        {items.length > 0 && (
          <div className="notifs">
            {days.map((d) => (
              <section key={d.day} className="notif-day">
                <h2>{d.day}</h2>
                {d.items.map((n) => (
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
                    <span className="dot" aria-label={n.readAt ? undefined : "не прочитано"} />
                    <span className="txt">
                      <b>{n.title}</b>
                      {n.body && <span className="notif-body">{n.body}</span>}
                    </span>
                    <span className="when">{timeAgo(n.created)}</span>
                  </button>
                ))}
              </section>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function dayName(iso: string): string {
  const d = new Date(iso);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(new Date()) - start(d)) / 86_400_000);
  if (diff <= 0) return "Сегодня";
  if (diff === 1) return "Вчера";
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
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
          <div className="me-line">
            <span className="me" aria-hidden="true">
              {(session?.user.name || session?.user.login || "?").slice(0, 2).toUpperCase()}
            </span>
            <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <h2>{session?.user.name}</h2>
              <span className="muted">
                {session?.user.login}
                {session?.user.isAdmin ? " · администратор" : ""}
                {session?.user.email ? ` · ${session.user.email}` : ""}
              </span>
            </span>
          </div>
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
                  {code && <p className="secret">{code}</p>}
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
              {token && <p className="secret">{token}</p>}
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
  const [sp, setSp] = useSearchParams();
  const [editing, setEditing] = useState<{ id?: number; text: string }>();
  const act = useAction();
  const installed = new Set((rules.data ?? []).map((r) => r.name));
  const selected = Number(sp.get("rule") ?? "") || rules.data?.[0]?.id;
  const current = rules.data?.find((r) => r.id === selected);
  return (
    <main className="main">
      <header className="topbar">
        <h1>Автоматизации</h1>
        <span className="sub d-only">правила запускают агентов, уведомления и вопросы людям</span>
        <span className="grow" />
        <button type="button" className="btn primary" onClick={() => setEditing({ text: JSON.stringify(EMPTY_RULE, null, 2) })}>
          <Icon.plus size={13} />
          <span className="d-only">Новое правило</span>
        </button>
      </header>
      <div className="split">
        <section className="split-list" aria-label="Правила">
          {rules.data?.map((r) => (
            <button type="button" key={r.id} className={`pick${r.id === current?.id ? " on" : ""}`} onClick={() => setSp({ rule: String(r.id) })}>
              <span className="t">
                <span className={`state-dot ${r.enabled ? "ok" : "off"}`} />
                <span>{r.name}</span>
              </span>
              <span className="s">{describeTrigger(r)}</span>
              <span className="s">
                {r.lastRun ? `последний запуск ${timeAgo(r.lastRun.started)} · ${RUN_STATUS[r.lastRun.status] ?? r.lastRun.status}` : "ещё не запускалось"}
              </span>
            </button>
          ))}
          {rules.isSuccess && !rules.data.length && <p className="muted" style={{ margin: 0, padding: "4px 14px 8px" }}>Правил пока нет — начните с плейбука.</p>}
          {!!playbooks.data?.length && <span className="label">Плейбуки</span>}
          {playbooks.data?.map((p) => {
            const name = String((p.spec as { name?: string }).name ?? "");
            const added = installed.has(name);
            return (
              <div key={p.id} className="pick plain playbook">
                <span className="s">{p.title}</span>
                <span>
                  <button type="button" className="btn" disabled={added} onClick={() => void act(() => request("POST", `/api/automations/playbooks/${p.id}`), "Правило добавлено")}>
                    {added ? "Добавлен" : "Добавить"}
                  </button>
                </span>
              </div>
            );
          })}
        </section>
        <section className="split-main" aria-label="Правило">
          {current ? (
            <RuleView key={current.id} rule={current} onEdit={() => setEditing({ id: current.id, text: JSON.stringify(current.spec, null, 2) })} />
          ) : (
            <div className="pane-empty">
              <Icon.bolt size={22} />
              {rules.isPending ? "Загрузка…" : "Выберите правило или добавьте плейбук"}
            </div>
          )}
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

type Spec = { on?: Record<string, unknown>; steps?: Record<string, unknown>[] };
const STEP_FIELDS = new Set(["id", "if", "retry", "timeout", "onError"]);

function describeTrigger(rule: Automation): string {
  const on = (rule.spec as Spec).on ?? {};
  const where = on.where && typeof on.where === "object" ? Object.entries(on.where as Record<string, unknown>).map(([k, v]) => condition(k, v)) : [];
  let text: string;
  if (typeof on.event === "string") text = `Событие ${on.event}${where.length ? `, ${where.join(", ")}` : ""}`;
  else if (typeof on.schedule === "string") text = `Расписание ${on.schedule}${typeof on.tz === "string" ? `, ${on.tz}` : ""}`;
  else if (on.webhook) text = "Webhook";
  else text = "Вручную";
  if (!rule.enabled) text += " · выключено";
  if (rule.dryRun) text += " · пробный режим";
  return text;
}

function condition(key: string, v: unknown): string {
  if (Array.isArray(v)) return `${key} ∈ ${v.map(String).join(", ")}`;
  if (v && typeof v === "object") {
    const [op, arg] = Object.entries(v as Record<string, unknown>)[0] ?? ["", ""];
    const val = Array.isArray(arg) ? arg.map(String).join(", ") : String(arg);
    const ops: Record<string, string> = { not: "≠", contains: "содержит", not_contains: "без", gt: ">", lt: "<", prefix: "начинается с" };
    if (op === "exists") return arg ? `есть ${key}` : `нет ${key}`;
    return `${key} ${ops[op] ?? op} ${val}`;
  }
  return `${key} = ${String(v)}`;
}

/** `{{ event.task.id }}` reads as ‹task.id› in step summaries. */
function untemplate(text: string): string {
  return text.replace(/\{\{\s*([^}|]+?)\s*(\|[^}]*)?\}\}/g, (_, path: string) => `‹${path.replace(/^event\./, "").replace(/^steps\.[^.]+\.output\./, "")}›`);
}

function describeStep(step: Record<string, unknown>): { kind: string; text: string } {
  const kind = Object.keys(step).find((k) => !STEP_FIELDS.has(k)) ?? "?";
  const body = (step[kind] ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    const v = keys.map((k) => body[k]).find((x) => typeof x === "string" && x) as string | undefined;
    return v && untemplate(v);
  };
  const to = (v: unknown) => (Array.isArray(v) ? v.map(String).join(", ") : String(v ?? ""));
  let text: string;
  switch (kind) {
    case "agent":
      text = `${String(body.role ?? "агент")}: ${short(pick("goal") ?? "", 90)}`;
      break;
    case "notify":
      text = `${short(pick("title") ?? "уведомление", 70)} → ${to(body.to)}`;
      break;
    case "ask":
      text = `Вопросы → ${to(body.to)}`;
      break;
    case "task.status":
      text = `Статус → ${String(body.to ?? "")}`;
      break;
    case "changelog.add":
      text = `Запись в чейнджлог: ${untemplate(String(body.group ?? "changed"))}`;
      break;
    case "wait":
      text = `Пауза ${String(body.for ?? "")}`;
      break;
    case "team":
      text = `Команда ${String(body.template ?? "")}`;
      break;
    default:
      text = short(pick("text", "title", "version", "url") ?? body, 90);
  }
  return { kind, text };
}

function short(v: unknown, n: number): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function RuleView({ rule, onEdit }: { rule: Automation; onEdit: () => void }) {
  const act = useAction();
  const steps = ((rule.spec as Spec).steps ?? []).map(describeStep);
  return (
    <>
      <div className="pane-head">
        <div className="ttl">
          <h2>{rule.name}</h2>
          <span className="sub">{describeTrigger(rule)}</span>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={rule.enabled} onChange={(e) => void act(() => request("POST", `/api/automations/${rule.id}/enabled`, { enabled: e.target.checked }))} />
          Включено
        </label>
        <button type="button" className="btn" onClick={onEdit}>
          Изменить
        </button>
        {rule.trigger === "manual" && (
          <button type="button" className="btn" onClick={() => void act(() => request("POST", `/api/automations/${rule.id}/run`, {}), "Запущено")}>
            Запустить
          </button>
        )}
      </div>
      <div className="pane-body">
        {steps.length > 0 && (
          <ol className="steps" aria-label="Шаги">
            {steps.map((st, i) => (
              <li key={i}>
                <span className="k">{st.kind}</span>
                <span className="d">{st.text}</span>
              </li>
            ))}
          </ol>
        )}
        <Runs automation={rule.id} />
      </div>
    </>
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
  useTick();
  const runs = useRuns(automation);
  const [open, setOpen] = useState<number>();
  const run = useRun(open);
  const act = useAction();
  return (
    <section>
      <h3>Последние запуски</h3>
      {!runs.data?.length ? (
        <p className="muted" style={{ margin: 0 }}>
          {runs.isPending ? "Загрузка…" : "Запусков пока не было."}
        </p>
      ) : (
        <div className="runs">
          {runs.data.map((r) => (
            <div key={r.id} className="run">
              <button type="button" className="run-row" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? undefined : r.id)}>
                <span className={`st ${r.status}`}>
                  {r.status === "running" ? <span className="spin" /> : <span className={`state-dot ${r.status}`} />}
                  {RUN_STATUS[r.status] ?? r.status}
                </span>
                <span className="id">#{r.id}</span>
                <span className="nt">{r.error ?? triggerNote(r.triggerKey)}</span>
                <span className="when">{timeAgo(r.started)}</span>
              </button>
              {open === r.id && run.data && (
                <ol className="run-steps">
                  {run.data.steps.map((s) => (
                    <li key={s.id}>
                      <details>
                        <summary>
                          <span className="sid">{s.stepId}</span>
                          <span>
                            {s.kind} · {RUN_STATUS[s.status] ?? s.status}
                            {s.attempt > 1 ? ` · попытка ${s.attempt}` : ""}
                            {s.error && <span className="err"> · {s.error}</span>}
                          </span>
                        </summary>
                        <pre className="view">{JSON.stringify({ input: s.input, output: s.output, wait: s.wait }, null, 2)}</pre>
                      </details>
                    </li>
                  ))}
                  {["queued", "running", "waiting"].includes(run.data.status) && (
                    <li>
                      <button type="button" className="btn" onClick={() => void act(() => request("POST", `/api/runs/${r.id}/cancel`), "Отменено")}>
                        Отменить запуск
                      </button>
                    </li>
                  )}
                </ol>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function triggerNote(key: string): string {
  const kind = key.split(":")[0];
  if (kind === "event") return `по событию #${key.split(":").at(-1)}`;
  return ({ schedule: "по расписанию", manual: "запущено вручную", webhook: "по webhook" } as Record<string, string>)[kind] ?? key;
}

// ------------------------------------------------------------------ knowledge proposals

/** Page body with the frontmatter shown apart, so the comparison reads like the page. */
function PageBody({ text }: { text: string }) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  return (
    <>
      {m && <pre className="frontmatter">{m[1]}</pre>}
      <Markdown text={m ? text.slice(m[0].length) : text} />
    </>
  );
}

export function ProposalsPage() {
  useTick();
  const [sp, setSp] = useSearchParams();
  const list = useProposals();
  const selected = Number(sp.get("proposal") ?? "") || list.data?.[0]?.id;
  const one = useProposal(selected);
  const act = useAction();
  const decide = (verb: "approve" | "reject", force = false) =>
    act(async () => {
      await request("POST", `/api/docs/proposals/${selected}/${verb}`, { force });
      setSp({});
    }, verb === "approve" ? "Правка опубликована" : "Предложение отклонено");
  const p = one.data?.proposal;
  return (
    <main className="main">
      <header className="topbar">
        <h1>Предложения</h1>
        <span className="sub d-only">агенты предлагают правки знаний, владельцы раздела решают</span>
        <span className="grow" />
        <Link className="btn" to="/docs">
          К документации
        </Link>
      </header>
      <div className="split narrow">
        <section className="split-list" aria-label="Открытые предложения">
          {list.isSuccess && !list.data.length && <p className="muted" style={{ margin: 0, padding: "4px 14px" }}>Открытых предложений нет.</p>}
          {list.data?.map((x) => (
            <button type="button" key={x.id} className={`pick plain${selected === x.id ? " on" : ""}`} onClick={() => setSp({ proposal: String(x.id) })}>
              <span className="t">
                <span>{pageTitle(x.path)}</span>
              </span>
              <span className="s">
                {x.author}
                {x.authorKind === "agent" ? " (агент)" : ""}
                {x.task ? ` · по задаче ${x.task}` : ""} · {timeAgo(x.created)}
              </span>
            </button>
          ))}
        </section>
        <section className="split-main" aria-label="Предложение">
          {!p ? (
            <div className="pane-empty">
              <Icon.proposal size={22} />
              {list.isPending || (selected && one.isPending) ? "Загрузка…" : "Здесь появятся правки, которые ждут вашего решения"}
            </div>
          ) : (
            <>
              <div className="pane-head">
                <div className="ttl">
                  <h2>{pageTitle(p.path)}</h2>
                  <span className="sub">
                    <span className="mono">{p.path}</span>
                    {one.data!.owners.length > 0 ? ` · владельцы раздела: ${one.data!.owners.join(", ")}` : ""}
                  </span>
                </div>
                <button type="button" className="btn" onClick={() => void decide("reject")}>
                  Отклонить
                </button>
                <button type="button" className="btn" onClick={() => void decide("approve", true)} title="Если страница изменилась после предложения">
                  Опубликовать поверх
                </button>
                <button type="button" className="btn primary" onClick={() => void decide("approve")}>
                  Опубликовать
                </button>
              </div>
              <div className="proposal-state">
                <span className={`state-dot ${one.data!.current == null ? "running" : "ok"}`} />
                {one.data!.current == null ? "Новая страница" : "Правка существующей страницы — при конфликте сервер попросит опубликовать поверх"}
              </div>
              {p.note && <p className="proposal-note">{p.note}</p>}
              <div className="compare">
                <div>
                  <span className="hd">Сейчас</span>
                  <div className="bd">{one.data!.current ? <PageBody text={one.data!.current} /> : <p className="muted">Страницы ещё нет</p>}</div>
                </div>
                <div>
                  <span className="hd">Предложение</span>
                  <div className="bd">
                    <PageBody text={p.content ?? ""} />
                  </div>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}

function pageTitle(path: string): string {
  return path.replace(/\.md$/, "").split("/").join(" / ");
}
