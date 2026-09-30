// The person's own settings, one tab each: the account (photo, name, login, mail),
// signing in (password), Telegram, and personal tokens for the CLI and MCP.

import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { NavLink, useParams } from "react-router";
import { PersonAvatar, PROJECT_ROLE_NAME, usePatchUser, useSetAvatar } from "@/entities/project";
import { useChannels } from "@/entities/platform";
import { type SessionUser, useSession } from "@/entities/session";
import { request } from "@/shared/api";
import { Icon, useToast } from "@/shared/ui";
import { TokensTab } from "./TokensTab.tsx";
import "@/shared/ui/settings.css";

const TABS = [
  { id: "", title: "Аккаунт" },
  { id: "security", title: "Вход и пароль" },
  { id: "telegram", title: "Telegram" },
  { id: "tokens", title: "Токены CLI и MCP" },
] as const;

/** Run an action; a failure becomes an error toast, success an optional one. */
export function useAct() {
  const toast = useToast();
  const qc = useQueryClient();
  return async (fn: () => Promise<unknown>, ok?: string): Promise<boolean> => {
    try {
      await fn();
      if (ok) toast(ok);
      await qc.invalidateQueries();
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
      return false;
    }
  };
}

export function ProfilePage() {
  const session = useSession().data;
  const { tab = "" } = useParams();
  const local = session?.mode === "local";
  return (
    <main className="main">
      <header className="topbar">
        <h1>Профиль</h1>
        <nav className="st-tabs" aria-label="Разделы профиля">
          {TABS.map((t) => (
            <NavLink key={t.id} to={t.id ? `/profile/${t.id}` : "/profile"} end className={({ isActive }) => (isActive ? "on" : undefined)}>
              {t.title}
            </NavLink>
          ))}
        </nav>
      </header>
      <div className="scroll">
        {!session ? null : local ? (
          <div className="st-body">
            <div className="st-head">
              <h2>Локальный режим</h2>
              <p>
                На сервере пока нет пользователей, и он открыт без входа только с этой машины. Создайте учётную запись администратора на странице «Проект и люди» или
                командой <code>genie user add &lt;login&gt; --admin --password-stdin</code>: тогда здесь появятся фото, пароль, Telegram и токены.
              </p>
            </div>
          </div>
        ) : tab === "security" ? (
          <SecurityTab />
        ) : tab === "telegram" ? (
          <TelegramTab />
        ) : tab === "tokens" ? (
          <TokensTab />
        ) : (
          <AccountTab key={`${session.user.login}:${session.user.name}:${session.user.email ?? ""}`} user={session.user} />
        )}
      </div>
    </main>
  );
}

function AccountTab({ user }: { user: SessionUser }) {
  const session = useSession().data;
  const patch = usePatchUser();
  const act = useAct();
  const initial = { name: user.name, login: user.login, email: user.email ?? "" };
  const [form, setForm] = useState(initial);
  const login = form.login.trim().toLowerCase();
  const loginOk = /^[a-z0-9._-]+$/.test(login);
  const loginChanged = login !== user.login;
  const dirty = form.name.trim() !== user.name || loginChanged || form.email.trim() !== (user.email ?? "");
  const projects = session?.projects ?? [];
  return (
    <div className="st-body">
      <div className="st-head">
        <h2>Аккаунт</h2>
        <p>Как вас видят люди и агенты в задачах, почте команды и уведомлениях.</p>
      </div>

      <form
        className="st-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (!dirty || !loginOk) return;
          void act(
            () => patch.mutateAsync({ id: user.id, patch: { name: form.name.trim(), login, email: form.email.trim() || null } }),
            loginChanged ? `Теперь вы @${login}` : "Сохранено",
          );
        }}
      >
        <div className="st-row">
          <div className="lbl">
            <b>Фото</b>
            <span>Видно в списке людей, в задачах и в меню слева.</span>
          </div>
          <Photo user={user} />
        </div>
        <div className="st-row">
          <label className="lbl" htmlFor="pf-name">
            <b>Отображаемое имя</b>
            <span>Так вас называют в интерфейсе и письмах агентов.</span>
          </label>
          <div className="ctl">
            <input id="pf-name" className="st-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" />
          </div>
        </div>
        <div className="st-row">
          <label className="lbl" htmlFor="pf-login">
            <b>Логин</b>
            <span>Для входа и упоминаний. Латиница, цифры, точка, дефис, подчёркивание.</span>
          </label>
          <div className="ctl">
            <div className="st-prefixed">
              <span>@</span>
              <input
                id="pf-login"
                value={form.login}
                onChange={(e) => setForm({ ...form, login: e.target.value })}
                autoComplete="username"
                spellCheck={false}
                aria-invalid={!loginOk}
                required
              />
            </div>
            {!loginOk && login && <p className="pj-bad">Только латиница, цифры, точка, дефис и подчёркивание.</p>}
            {loginChanged && loginOk && (
              <div className="st-note" role="note">
                <span>
                  Входить нужно будет как <b>@{login}</b>. Сессии, токены и участие в проектах сохранятся, задачи с ответственным @{user.login} перейдут на новый логин.
                </span>
              </div>
            )}
          </div>
        </div>
        <div className="st-row">
          <label className="lbl" htmlFor="pf-mail">
            <b>Почта</b>
            <span>Сюда приходят уведомления, если не привязан Telegram.</span>
          </label>
          <div className="ctl">
            <input id="pf-mail" type="email" className="st-input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" />
          </div>
        </div>
        <div className="st-foot">
          <span className="grow">{dirty ? "Есть несохранённые изменения" : ""}</span>
          <button type="button" className="btn ghost" disabled={!dirty} onClick={() => setForm(initial)}>
            Отменить
          </button>
          <button className="btn primary" disabled={!dirty || !loginOk || patch.isPending}>
            Сохранить
          </button>
        </div>
      </form>

      <section className="st-card">
        <div className="st-row">
          <div className="lbl">
            <b>Учётная запись</b>
          </div>
          <dl className="st-facts">
            <dt>На сервере</dt>
            <dd>{user.isAdmin ? "администратор" : "пользователь"}</dd>
            <dt>Проекты</dt>
            <dd>{projects.length ? projects.map((p) => `${p.name} (${PROJECT_ROLE_NAME[p.role]})`).join(", ") : "нет"}</dd>
            {user.created && (
              <>
                <dt>С нами с</dt>
                <dd>{new Date(user.created).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}</dd>
              </>
            )}
          </dl>
        </div>
      </section>
    </div>
  );
}

/** Shrink a picture to a centred square: small enough to store and quick to show everywhere. */
async function squareImage(file: File, side = 256): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const cut = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("Браузер не умеет обрабатывать картинки");
  g.fillStyle = "#16171b";
  g.fillRect(0, 0, side, side);
  g.drawImage(bitmap, (bitmap.width - cut) / 2, (bitmap.height - cut) / 2, cut, cut, 0, 0, side, side);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Не удалось сжать картинку"))), "image/jpeg", 0.9));
}

function Photo({ user }: { user: SessionUser }) {
  const set = useSetAvatar();
  const act = useAct();
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="st-photo">
      <PersonAvatar login={user.login} name={user.name} src={user.avatar} size="xl" prefix="Ваше фото" />
      <div className="acts">
        <div>
          <button type="button" className="btn" disabled={set.isPending} onClick={() => input.current?.click()}>
            <Icon.upload size={13} />
            {user.avatar ? "Заменить" : "Загрузить фото"}
          </button>
          {user.avatar && (
            <button type="button" className="btn ghost" disabled={set.isPending} onClick={() => void act(() => set.mutateAsync({ id: user.id, image: null }), "Фото убрано")}>
              Убрать
            </button>
          )}
        </div>
        <span className="hint">PNG, JPG или WebP до 10 МБ. Обрежем по центру до квадрата.</span>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            void act(async () => {
              if (file.size > 10 * 1024 * 1024) throw new Error("Картинка больше 10 МБ");
              await set.mutateAsync({ id: user.id, image: await squareImage(file) });
            }, "Фото обновлено");
          }}
        />
      </div>
    </div>
  );
}

function SecurityTab() {
  const act = useAct();
  const [pw, setPw] = useState({ current: "", password: "" });
  return (
    <div className="st-body">
      <div className="st-head">
        <h2>Вход и пароль</h2>
        <p>После смены пароля все сессии закрываются, в том числе эта: войдите снова с новым паролем. Токены CLI и MCP продолжают работать.</p>
      </div>
      <form
        className="st-card"
        onSubmit={(e) => {
          e.preventDefault();
          void act(() => request("POST", "/api/auth/password", pw), "Пароль изменён, войдите снова").then((ok) => ok && window.location.assign("/"));
        }}
      >
        <div className="st-row">
          <label className="lbl" htmlFor="pf-cur">
            <b>Текущий пароль</b>
          </label>
          <div className="ctl">
            <input id="pf-cur" type="password" className="st-input" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required />
          </div>
        </div>
        <div className="st-row">
          <label className="lbl" htmlFor="pf-new">
            <b>Новый пароль</b>
            <span>Не короче 8 символов.</span>
          </label>
          <div className="ctl">
            <input
              id="pf-new"
              type="password"
              className="st-input"
              autoComplete="new-password"
              minLength={8}
              value={pw.password}
              onChange={(e) => setPw({ ...pw, password: e.target.value })}
              required
            />
          </div>
        </div>
        <div className="st-foot">
          <span className="grow" />
          <button className="btn primary" disabled={!pw.current || pw.password.length < 8}>
            Сменить пароль
          </button>
        </div>
      </form>
    </div>
  );
}

function TelegramTab() {
  const channels = useChannels().data;
  const act = useAct();
  const [code, setCode] = useState<string>();
  const linked = channels?.links.find((l) => l.channel === "telegram");
  return (
    <div className="st-body">
      <div className="st-head">
        <h2>Telegram</h2>
        <p>Уведомления и вопросы от агентов приходят в Telegram, отвечать можно прямо там.</p>
      </div>
      <section className="st-card">
        <div className="st-card-body">
          {!channels ? (
            <p className="muted">Загрузка…</p>
          ) : !channels.telegram ? (
            <p className="muted">
              Telegram не настроен на сервере: администратору нужно задать <code>telegram.token</code> в config.json.
            </p>
          ) : linked ? (
            <div className="pj-row">
              <span className="grow">Чат привязан.</span>
              <button type="button" className="btn" onClick={() => void act(() => request("DELETE", "/api/me/channels/telegram"), "Telegram отвязан")}>
                Отвязать
              </button>
            </div>
          ) : (
            <>
              <div>
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
              </div>
              {code && <p className="secret">{code}</p>}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
