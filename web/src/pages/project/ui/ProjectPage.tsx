// The project's page: its name, autonomy and default integration; its people with
// their roles; invitation links. Admins of the project change them, the rest see them.

import { useState } from "react";
import {
  AUTONOMY,
  type Membership,
  PersonAvatar,
  personName,
  PROJECT_ROLE_HINT,
  PROJECT_ROLE_NAME,
  type ProjectInfo,
  type ProjectRole,
  useInvite,
  useMembers,
  usePatchProject,
  useProjects,
  useRemoveMember,
  useSetMember,
  useUsers,
} from "@/entities/project";
import { useSession } from "@/entities/session";
import { request } from "@/shared/api";
import { ConfirmDialog, Icon, useToast } from "@/shared/ui";
import "./project.css";

export const ROLES: ProjectRole[] = ["viewer", "member", "admin", "owner"];

/** Run an action; a failure becomes an error toast, success an optional one. */
export function useAct() {
  const toast = useToast();
  return async (fn: () => Promise<unknown>, ok?: string): Promise<boolean> => {
    try {
      await fn();
      if (ok) toast(ok);
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
      return false;
    }
  };
}

export function ProjectPage() {
  const session = useSession().data;
  const projects = useProjects();
  const project = projects.data?.find((p) => p.slug === session?.project);
  const local = session?.mode === "local";
  const admin = !!project && (project.role === "admin" || project.role === "owner");
  return (
    <main className="main">
      <header className="topbar">
        <h1>Проект</h1>
        {project && (
          <span className="sub">
            {project.name} · {PROJECT_ROLE_NAME[project.role]}
          </span>
        )}
      </header>
      <div className="scroll settings">
        {!project ? (
          <div className="empty">{projects.isPending ? "Загрузка…" : (projects.error?.message ?? "Проект не выбран")}</div>
        ) : (
          <>
            <General key={`${project.slug}:${project.name}:${project.integration}`} project={project} admin={admin} />
            {local ? <FirstAdmin /> : <People slug={project.slug} admin={admin} me={session?.user.login} />}
            {admin && !local && <Invite slug={project.slug} />}
          </>
        )}
      </div>
    </main>
  );
}

function General({ project, admin }: { project: ProjectInfo; admin: boolean }) {
  const [name, setName] = useState(project.name);
  const [integration, setIntegration] = useState(project.integration);
  const patch = usePatchProject();
  const act = useAct();
  const save = (p: Parameters<typeof patch.mutateAsync>[0]["patch"], ok: string) => act(() => patch.mutateAsync({ slug: project.slug, patch: p }), ok);
  const dirty = name.trim() !== project.name || integration.trim() !== project.integration;
  const autonomy = AUTONOMY.find((a) => a.id === project.autonomy);
  return (
    <section>
      <h2>Настройки</h2>
      <dl className="pj-facts">
        <dt>Код</dt>
        <dd className="mono">{project.slug}</dd>
        <dt>Репозиторий</dt>
        <dd className={project.repo ? "mono" : "muted"}>{project.repo ?? "без кода: результат — артефакты задач и страницы документации"}</dd>
        <dt>Документация</dt>
        <dd className="mono">{project.space}/</dd>
        {!admin && (
          <>
            <dt>Оркестратор</dt>
            <dd>{autonomy ? `${autonomy.name}: ${autonomy.hint}` : project.autonomy}</dd>
            <dt>Интеграция</dt>
            <dd className={project.integration ? undefined : "muted"}>{project.integration || "не задана: команда договаривается о ней в каждой задаче"}</dd>
          </>
        )}
      </dl>
      {admin && (
        <>
          <form
            className="pj-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save({ name: name.trim(), integration: integration.trim() }, "Настройки проекта сохранены");
            }}
          >
            <label className="field">
              Название
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
            <label className="field">
              Интеграция по умолчанию
              <textarea
                rows={2}
                value={integration}
                placeholder={project.repo ? "Например: владелец смотрит ветку genie/<задача> и сливает её в main" : "Например: результат — страница документации и артефакт в задаче"}
                onChange={(e) => setIntegration(e.target.value)}
              />
              <span className="pj-hint">Как результат задачи попадает в систему, если в самой задаче не договорились иначе. Команда получает это вместе с задачей.</span>
            </label>
            <button className="btn" disabled={!dirty || patch.isPending}>
              Сохранить
            </button>
          </form>
          <fieldset className="pj-choice">
            <legend>Оркестратор</legend>
            {AUTONOMY.map((a) => (
              <label key={a.id} className={`pj-option${project.autonomy === a.id ? " on" : ""}`}>
                <input type="radio" name="autonomy" checked={project.autonomy === a.id} onChange={() => void save({ autonomy: a.id }, `Оркестратор: ${a.name.toLowerCase()}`)} />
                <span>
                  <b>{a.name}</b>
                  <span className="muted">{a.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
        </>
      )}
    </section>
  );
}

function People({ slug, admin, me }: { slug: string; admin: boolean; me?: string }) {
  const members = useMembers(slug);
  const users = useUsers(admin);
  const setMember = useSetMember();
  const remove = useRemoveMember();
  const act = useAct();
  const [adding, setAdding] = useState<{ user: string; role: ProjectRole }>({ user: "", role: "member" });
  const [removing, setRemoving] = useState<Membership>();
  const list = members.data ?? [];
  const outside = (users.data ?? []).filter((u) => !u.disabled && !list.some((m) => m.user.id === u.id));
  return (
    <section>
      <h2>
        Люди <span className="n">{list.length || ""}</span>
      </h2>
      {list.length > 0 && (
        <ul className="pj-people">
          {list.map((m) => (
            <li key={m.user.id} className={m.user.disabled ? "off" : undefined}>
              <PersonAvatar login={m.user.login} name={m.user.name} size="md" prefix="" />
              <span className="who">
                <b>
                  {personName(m.user)}
                  {m.user.login === me ? " — вы" : ""}
                </b>
                <span className="muted">
                  @{m.user.login}
                  {m.user.email ? ` · ${m.user.email}` : ""}
                  {m.user.isAdmin ? " · администратор сервера" : ""}
                  {m.user.disabled ? " · отключён" : ""}
                </span>
              </span>
              {admin && m.user.login !== me ? (
                <>
                  <select
                    aria-label={`Роль ${m.user.login}`}
                    value={m.role}
                    onChange={(e) => {
                      const role = e.target.value as ProjectRole;
                      void act(() => setMember.mutateAsync({ slug, user: m.user.id, role }), `${personName(m.user)}: ${PROJECT_ROLE_NAME[role]}`);
                    }}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {PROJECT_ROLE_NAME[r]}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="icon-btn" aria-label={`Убрать ${m.user.login} из проекта`} title="Убрать из проекта" onClick={() => setRemoving(m)}>
                    <Icon.trash size={13} />
                  </button>
                </>
              ) : (
                <span className="pj-role">{PROJECT_ROLE_NAME[m.role]}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {!list.length && <p className="muted">{members.isPending ? "Загрузка…" : "В проекте пока никого нет: пригласите людей ссылкой ниже."}</p>}
      <p className="muted">Администраторы сервера работают во всех проектах как владельцы, даже если их нет в списке.</p>
      {admin && outside.length > 0 && (
        <form
          className="pj-row"
          onSubmit={(e) => {
            e.preventDefault();
            const user = outside.find((u) => String(u.id) === adding.user);
            if (!user) return;
            void act(() => setMember.mutateAsync({ slug, user: user.id, role: adding.role }), `${personName(user)} теперь в проекте`).then(
              (ok) => ok && setAdding({ user: "", role: "member" }),
            );
          }}
        >
          <select aria-label="Кого добавить" value={adding.user} onChange={(e) => setAdding({ ...adding, user: e.target.value })}>
            <option value="">Человек с сервера…</option>
            {outside.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name ? `${u.name} (@${u.login})` : `@${u.login}`}
              </option>
            ))}
          </select>
          <select aria-label="Роль нового участника" value={adding.role} onChange={(e) => setAdding({ ...adding, role: e.target.value as ProjectRole })}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {PROJECT_ROLE_NAME[r]}
              </option>
            ))}
          </select>
          <button className="btn" disabled={!adding.user || setMember.isPending}>
            Добавить в проект
          </button>
        </form>
      )}
      <dl className="pj-roles">
        {ROLES.map((r) => (
          <div key={r}>
            <dt>{PROJECT_ROLE_NAME[r]}</dt>
            <dd>{PROJECT_ROLE_HINT[r]}</dd>
          </div>
        ))}
      </dl>
      {removing && (
        <ConfirmDialog
          title="Убрать из проекта?"
          confirmLabel="Убрать"
          danger
          busy={remove.isPending}
          onClose={() => setRemoving(undefined)}
          onConfirm={() =>
            void act(() => remove.mutateAsync({ slug, user: removing.user.id }), `${personName(removing.user)} больше не в проекте`).then(() => setRemoving(undefined))
          }
        >
          {personName(removing.user)} перестанет видеть задачи и документацию проекта. Учётная запись на сервере останется; задачи, где человек ответственный, лучше передать
          другому.
        </ConfirmDialog>
      )}
    </section>
  );
}

function Invite({ slug }: { slug: string }) {
  const invite = useInvite();
  const act = useAct();
  const toast = useToast();
  const [role, setRole] = useState<ProjectRole>("member");
  const [email, setEmail] = useState("");
  const [link, setLink] = useState<string>();
  return (
    <section>
      <h2>Пригласить</h2>
      <p className="muted">
        Ссылка открывается один раз и действует 7 дней: человек сам выбирает логин и пароль и сразу попадает в проект с выбранной ролью. Почта, если её указать, станет
        адресом его уведомлений.
      </p>
      <form
        className="pj-row"
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => setLink((await invite.mutateAsync({ slug, role, email: email.trim() })).url));
        }}
      >
        <select aria-label="Роль приглашённого" value={role} onChange={(e) => setRole(e.target.value as ProjectRole)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {PROJECT_ROLE_NAME[r]}
            </option>
          ))}
        </select>
        <input type="email" aria-label="Почта (необязательно)" placeholder="почта (необязательно)" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className="btn primary" disabled={invite.isPending}>
          Создать ссылку
        </button>
      </form>
      {link && (
        <div className="pj-link">
          <span className="secret">{link}</span>
          <button
            type="button"
            className="btn"
            onClick={() =>
              void navigator.clipboard?.writeText(link).then(
                () => toast("Ссылка скопирована"),
                () => toast("Скопируйте ссылку вручную", "error"),
              )
            }
          >
            Скопировать
          </button>
        </div>
      )}
    </section>
  );
}

/** Local mode: the server has no users yet and trusts this machine. The first account ends that. */
function FirstAdmin() {
  const act = useAct();
  const [form, setForm] = useState({ login: "", name: "", password: "" });
  return (
    <section>
      <h2>Люди</h2>
      <p className="muted">
        Пользователей пока нет, и сервер открыт без входа — только с этой машины. Создайте учётную запись администратора: после этого вход станет обязательным для всех, а
        остальных людей вы пригласите ссылками.
      </p>
      <form
        className="auth-form narrow"
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await request("POST", "/api/users", { login: form.login.trim(), name: form.name.trim(), password: form.password, isAdmin: true });
            await request("POST", "/api/auth/login", { login: form.login.trim(), password: form.password });
            window.location.assign("/project");
          });
        }}
      >
        <label className="field">
          Логин (латиница)
          <input autoComplete="username" value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} required />
        </label>
        <label className="field">
          Имя
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label className="field">
          Пароль (не короче 8 символов)
          <input type="password" autoComplete="new-password" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
        </label>
        <button className="btn primary">Создать администратора и войти</button>
      </form>
    </section>
  );
}
