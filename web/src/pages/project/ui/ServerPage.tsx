// The server, for its administrators: projects (and a new one), the people with
// accounts (administrator rights, switching an account off), a new account.

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  AUTONOMY,
  DOCTOR_AREA,
  type DoctorCheck,
  doctorSummary,
  hoursText,
  PersonAvatar,
  personName,
  PROJECT_ROLE_NAME,
  useCreateProject,
  useCreateUser,
  useDoctor,
  usePatchUser,
  useStats,
  useSyncVaultNow,
  useVaultSync,
  useProjects,
  useUsers,
} from "@/entities/project";
import { useSession } from "@/entities/session";
import { request } from "@/shared/api";
import { Icon } from "@/shared/ui";
import { useAct } from "./ProjectPage.tsx";
import "./project.css";

export function ServerPage() {
  const session = useSession().data;
  const admin = !!session?.user.isAdmin;
  const local = session?.mode === "local";
  return (
    <main className="main">
      <header className="topbar">
        <h1>Сервер</h1>
        <span className="sub">{local ? "локальный режим" : "администрирование"}</span>
      </header>
      <div className="scroll settings">
        {!admin ? (
          <div className="empty">Эта страница — для администраторов сервера.</div>
        ) : (
          <>
            <Health />
            <Activity />
            <Knowledge />
            <Projects current={session?.project} />
            {!local && <Accounts me={session?.user.login} />}
          </>
        )}
      </div>
    </main>
  );
}

/** The preflight of `genie doctor`: what is broken first, what works folded. */
function Health() {
  const doctor = useDoctor(true);
  const [all, setAll] = useState(false);
  const checks = doctor.data?.checks ?? [];
  const summary = doctorSummary(checks);
  const order: Record<DoctorCheck["level"], number> = { fail: 0, warn: 1, ok: 2 };
  const shown = [...checks].sort((a, b) => order[a.level] - order[b.level]).filter((c) => all || c.level !== "ok");
  const fine = checks.filter((c) => c.level === "ok").length;
  return (
    <section>
      <h2>Готовность</h2>
      {doctor.isPending ? (
        <p className="muted">Проверяем сервер…</p>
      ) : doctor.isError ? (
        <p className="muted">Проверка не удалась: {doctor.error.message}</p>
      ) : (
        <>
          <p className={`pj-health ${summary.level}`}>
            {summary.text}
            <button type="button" className="btn ghost" disabled={doctor.isFetching} onClick={() => void doctor.refetch()}>
              <Icon.restart size={12} />
              Проверить снова
            </button>
          </p>
          <ul className="pj-checks">
            {shown.map((c, i) => (
              <li key={i} className={c.level}>
                <span className="lv" aria-label={c.level === "ok" ? "в порядке" : c.level === "warn" ? "предупреждение" : "проблема"} />
                <span className="area">{DOCTOR_AREA[c.area] ?? c.area}</span>
                <span className="txt">
                  {c.text}
                  {c.hint && c.level !== "ok" && <span className="hint">{c.hint}</span>}
                </span>
              </li>
            ))}
          </ul>
          {fine > 0 && (
            <button type="button" className="btn ghost" onClick={() => setAll(!all)}>
              {all ? "Скрыть то, что в порядке" : `Показать всё (в порядке: ${fine})`}
            </button>
          )}
          <p className="muted">
            То же в терминале: <code>genie doctor</code>.
          </p>
        </>
      )}
    </section>
  );
}

/** How the work went over the last days, per project (`genie stats`). */
function Activity() {
  const [days, setDays] = useState(7);
  const stats = useStats(days);
  const list = stats.data?.projects ?? [];
  return (
    <section>
      <h2>Как идёт работа</h2>
      <div className="seg" role="group" aria-label="Период" style={{ marginLeft: 0 }}>
        {[7, 30].map((d) => (
          <button key={d} type="button" className={d === days ? "on" : ""} aria-pressed={d === days} onClick={() => setDays(d)}>
            {d === 7 ? "Неделя" : "Месяц"}
          </button>
        ))}
      </div>
      {stats.isPending ? (
        <p className="muted">Загрузка…</p>
      ) : stats.isError ? (
        <p className="muted">{stats.error.message}</p>
      ) : (
        list.map((p) => (
          <dl key={p.project} className="pj-facts pj-stats">
            <dt className="pj-stats-head">{p.name}</dt>
            <dd className="pj-stats-head muted">{p.people.length ? `люди: ${p.people.join(", ")}` : "людей не было"}</dd>
            <dt>Задачи</dt>
            <dd>
              создано {p.created} (людьми {p.createdByPeople}), готово {p.done}, отменено {p.cancelled}; открыто сейчас {p.open}
            </dd>
            <dt>До готовности</dt>
            <dd>
              медиана {hoursText(p.cycleHoursMedian)}, 90% — до {hoursText(p.cycleHoursP90)}
            </dd>
            <dt>Вопросы агентов</dt>
            <dd>
              {p.decisions ? `${p.decisions}, люди отвечали за ${hoursText(p.answerHoursMedian)} (медиана)` : "не было"}
            </dd>
            <dt>Ревью</dt>
            <dd>{p.returns ? `работу возвращали на доработку ${p.returns} раз` : "без возвратов"}</dd>
            <dt>Агенты</dt>
            <dd>
              запусков {p.runs}
              {p.runsFailed ? `, со сбоем ${p.runsFailed}` : ""}; заданий {p.jobs}
              {p.jobsFailed ? `, со сбоем ${p.jobsFailed}` : ""}; вызовов MCP {p.mcpCalls}
            </dd>
            <dt>Знания</dt>
            <dd>
              предложений {p.proposals}, принято {p.proposalsApproved}, отклонено {p.proposalsRejected}
            </dd>
          </dl>
        ))
      )}
      <p className="muted">
        То же в терминале: <code>genie stats --days {days}</code>.
      </p>
    </section>
  );
}

/** The vault's git remote: where people open it in Obsidian, and how the last sync went. */
function Knowledge() {
  const sync = useVaultSync(true);
  const now = useSyncVaultNow();
  const act = useAct();
  const s = sync.data;
  const last = s?.last;
  return (
    <section>
      <h2>База знаний</h2>
      {!s ? (
        <p className="muted">{sync.isPending ? "Загрузка…" : sync.error?.message}</p>
      ) : !s.remote ? (
        <p className="muted">
          База знаний хранится только на этом сервере. Чтобы открыть её в Obsidian (и держать ещё одну копию), укажите git-репозиторий в <code>vault.remote</code> в
          config.json: сервер будет забирать и отправлять правки каждые {s.every} с.
        </p>
      ) : (
        <>
          <dl className="pj-facts">
            <dt>Репозиторий</dt>
            <dd className="mono">
              {s.remote}
              {last?.branch ? ` · ${last.branch}` : ""}
            </dd>
            <dt>Синхронизация</dt>
            <dd>
              {!last?.at ? (
                <span className="muted">ещё не было</span>
              ) : last.ok ? (
                <>
                  {new Date(last.at).toLocaleString("ru-RU")}: получено коммитов — {last.pulled}, отправлено — {last.pushed}
                </>
              ) : (
                <span className="pj-bad">
                  {new Date(last.at).toLocaleString("ru-RU")}: {last.error}
                </span>
              )}
            </dd>
            {last && last.conflicts.length > 0 && (
              <>
                <dt>Пересечения</dt>
                <dd>
                  {last.conflicts.map((c) => (
                    <div key={c}>{c}</div>
                  ))}
                </dd>
              </>
            )}
          </dl>
          <button type="button" className="btn" disabled={now.isPending} onClick={() => void act(() => now.mutateAsync(), "База знаний синхронизирована")}>
            <Icon.restart size={12} />
            Синхронизировать сейчас
          </button>
          <p className="muted">
            Склонируйте репозиторий и откройте папку как хранилище Obsidian; правки отправляйте в git (например, плагином Obsidian Git). Правки разных строк
            сливаются сами; если одни и те же строки изменили и там, и на сервере, на странице остаётся версия сервера, а версия из репозитория ложится рядом
            копией <code>.conflict</code> — ничего не теряется.
          </p>
        </>
      )}
    </section>
  );
}

function Projects({ current }: { current?: string }) {
  const projects = useProjects();
  const qc = useQueryClient();
  const act = useAct();
  return (
    <section>
      <h2>
        Проекты <span className="n">{projects.data?.length || ""}</span>
      </h2>
      <ul className="pj-people">
        {(projects.data ?? []).map((p) => (
          <li key={p.slug}>
            <span className="pj-mark" aria-hidden="true">
              {p.repo ? <Icon.file size={13} /> : <Icon.proposal size={13} />}
            </span>
            <span className="who">
              <b>
                {p.name}
                {p.slug === current ? " — открыт" : ""}
              </b>
              <span className="muted">
                <span className="mono">{p.slug}</span> · {p.repo ? <span className="mono">{p.repo}</span> : "без кода"} · {AUTONOMY.find((a) => a.id === p.autonomy)?.name ?? p.autonomy}
              </span>
            </span>
            {p.slug !== current && (
              <button
                type="button"
                className="btn ghost"
                onClick={() =>
                  void act(async () => {
                    await request("POST", "/api/session/project", { project: p.slug });
                    await qc.resetQueries();
                  }, `Открыт проект ${p.name}`)
                }
              >
                Открыть
              </button>
            )}
          </li>
        ))}
      </ul>
      <h3 className="pj-sub">Новый проект</h3>
      <NewProjectForm />
    </section>
  );
}

/** The first screen of a server without projects, for its administrator. */
export function FirstProjectPage() {
  return (
    <div className="auth-page">
      <div className="auth-card pj-first">
        <div className="auth-head">
          <span className="logo-mark lg">
            <Icon.mark size={22} />
          </span>
          <h1>Первый проект</h1>
          <p className="auth-sub">Проектов на сервере пока нет. Создайте первый — с репозиторием кода на этой машине или без кода.</p>
        </div>
        <NewProjectForm />
      </div>
    </div>
  );
}

/** A new project; the server switches to it. */
export function NewProjectForm({ onCreated }: { onCreated?: () => void }) {
  const create = useCreateProject();
  const qc = useQueryClient();
  const act = useAct();
  const [form, setForm] = useState({ slug: "", name: "", repo: "", prefix: "" });
  return (
    <form
      className="pj-form"
      onSubmit={(e) => {
        e.preventDefault();
        void act(async () => {
          const p = await create.mutateAsync({ slug: form.slug.trim(), name: form.name.trim(), repo: form.repo.trim() || undefined, prefix: form.prefix.trim() || undefined });
          await request("POST", "/api/session/project", { project: p.slug });
          await qc.resetQueries();
          setForm({ slug: "", name: "", repo: "", prefix: "" });
          onCreated?.();
        }, "Проект создан");
      }}
    >
      <div className="pj-pair">
        <label className="field">
          Код (латиница)
          <input value={form.slug} pattern="[a-z0-9][a-z0-9-]*" title="строчные латинские буквы, цифры и дефис" placeholder="shop" onChange={(e) => setForm({ ...form, slug: e.target.value })} required />
        </label>
        <label className="field">
          Название
          <input value={form.name} placeholder="Магазин" onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
      </div>
      <label className="field">
        Репозиторий кода на этой машине
        <input className="mono" value={form.repo} placeholder="/home/team/code/shop — пусто, если проект без кода" onChange={(e) => setForm({ ...form, repo: e.target.value })} />
        <span className="pj-hint">Репозиторий, где уже есть .genie/, подключается со всеми задачами. Без репозитория команды работают в своих каталогах, результат — артефакты и документация.</span>
      </label>
      <label className="field">
        Префикс задач
        <input value={form.prefix} placeholder="по коду проекта, например SHOP" onChange={(e) => setForm({ ...form, prefix: e.target.value.toUpperCase() })} />
      </label>
      <button className="btn primary" disabled={create.isPending}>
        Создать проект
      </button>
    </form>
  );
}

function Accounts({ me }: { me?: string }) {
  const users = useUsers();
  const patch = usePatchUser();
  const create = useCreateUser();
  const act = useAct();
  const [form, setForm] = useState({ login: "", name: "", password: "", isAdmin: false });
  const list = users.data ?? [];
  return (
    <section>
      <h2>
        Учётные записи <span className="n">{list.length || ""}</span>
      </h2>
      <p className="muted">Людей удобнее звать ссылкой-приглашением со страницы проекта. Отключённая учётная запись не может войти, её сессии и токены перестают работать.</p>
      <ul className="pj-people">
        {list.map((u) => (
          <li key={u.id} className={u.disabled ? "off" : undefined}>
            <PersonAvatar login={u.login} name={u.name} size="md" prefix="" />
            <span className="who">
              <b>
                {personName(u)}
                {u.login === me ? " — вы" : ""}
              </b>
              <span className="muted">
                @{u.login}
                {u.email ? ` · ${u.email}` : ""} · с {new Date(u.created).toLocaleDateString("ru-RU")}
              </span>
            </span>
            {u.login === me ? (
              <span className="pj-role">{u.isAdmin ? "администратор" : PROJECT_ROLE_NAME.member}</span>
            ) : (
              <>
                <label className="pj-check">
                  <input
                    type="checkbox"
                    checked={u.isAdmin}
                    onChange={(e) => {
                      const isAdmin = e.target.checked;
                      void act(() => patch.mutateAsync({ id: u.id, patch: { isAdmin } }), isAdmin ? `${personName(u)} — администратор сервера` : `${personName(u)} больше не администратор`);
                    }}
                  />
                  администратор
                </label>
                <label className="pj-check">
                  <input
                    type="checkbox"
                    checked={u.disabled}
                    onChange={(e) => {
                      const disabled = e.target.checked;
                      void act(() => patch.mutateAsync({ id: u.id, patch: { disabled } }), disabled ? `${personName(u)} отключён` : `${personName(u)} снова может войти`);
                    }}
                  />
                  отключён
                </label>
              </>
            )}
          </li>
        ))}
      </ul>
      <h3 className="pj-sub">Новая учётная запись</h3>
      <form
        className="pj-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await create.mutateAsync({ login: form.login.trim(), name: form.name.trim(), password: form.password, isAdmin: form.isAdmin });
            setForm({ login: "", name: "", password: "", isAdmin: false });
          }, "Учётная запись создана: добавьте человека в проект на странице проекта");
        }}
      >
        <div className="pj-pair">
          <label className="field">
            Логин (латиница)
            <input autoComplete="off" value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} required />
          </label>
          <label className="field">
            Имя
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
        </div>
        <label className="field">
          Пароль (не короче 8 символов)
          <input type="password" autoComplete="new-password" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
        </label>
        <label className="pj-check">
          <input type="checkbox" checked={form.isAdmin} onChange={(e) => setForm({ ...form, isAdmin: e.target.checked })} />
          администратор сервера: все проекты, роли агентов, учётные записи
        </label>
        <button className="btn" disabled={create.isPending}>
          Создать
        </button>
      </form>
    </section>
  );
}
