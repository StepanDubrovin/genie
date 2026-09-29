// The server, for its administrators: projects (and a new one), the people with
// accounts (administrator rights, switching an account off), a new account.

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  AUTONOMY,
  DOCTOR_AREA,
  type DoctorCheck,
  doctorSummary,
  PersonAvatar,
  personName,
  PROJECT_ROLE_NAME,
  useCreateProject,
  useCreateUser,
  useDoctor,
  usePatchUser,
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
