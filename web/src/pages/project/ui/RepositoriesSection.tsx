// The project's repositories: where they live, where they sit in the workspace, what agents
// may do in each. Everybody in the project sees the list; admins attach, change and check them.

import { useState } from "react";
import {
  type CheckLine,
  type ProjectRepo,
  PRESETS,
  presetName,
  presetOf,
  type RepoPolicy,
  useAddRepo,
  useCheckRepo,
  useGitHosts,
  usePatchRepo,
  useRemoveRepo,
  useRepos,
  useSyncRepo,
} from "@/entities/repo";
import { ConfirmDialog, Icon } from "@/shared/ui";
import { useAct } from "./ProjectPage.tsx";

export function RepositoriesSection({ admin }: { admin: boolean }) {
  const repos = useRepos();
  const hosts = useGitHosts(admin);
  const list = repos.data ?? [];
  return (
    <section>
      <h2>
        Репозитории <span className="n">{list.length || ""}</span>
      </h2>
      <p className="muted">
        Код проекта. Агенты работают с ним через сервер: у них нет доступа к хостингу, а что и куда они могут отправить, решает политика репозитория. Хостинги (адрес и токен)
        настраивает администратор сервера в <span className="mono">git.json</span>.
      </p>
      {list.length > 0 && (
        <ul className="rp-list">
          {list.map((r) => (
            <Repo key={`${r.name}:${r.mount}:${r.access}:${JSON.stringify(r.policy)}`} repo={r} admin={admin} />
          ))}
        </ul>
      )}
      {!list.length && <p className="muted">{repos.isPending ? "Загрузка…" : "Репозиториев нет: результат задач — артефакты и страницы документации."}</p>}
      {admin && <AddRepo hosts={hosts.data?.hosts.map((h) => h.id) ?? []} problems={hosts.data?.errors ?? []} loaded={!hosts.isPending} />}
    </section>
  );
}

function Repo({ repo, admin }: { repo: ProjectRepo; admin: boolean }) {
  const patch = usePatchRepo();
  const sync = useSyncRepo();
  const remove = useRemoveRepo();
  const check = useCheckRepo();
  const act = useAct();
  const [removing, setRemoving] = useState(false);
  const [probe, setProbe] = useState(false);
  const [report, setReport] = useState<CheckLine[]>();
  const [json, setJson] = useState<string>();
  const preset = presetOf(repo.policy);
  const changePolicy = (policy: RepoPolicy, ok: string) => act(() => patch.mutateAsync({ name: repo.name, patch: { policy } }), ok);
  return (
    <li className="rp">
      <div className="rp-head">
        <b>{repo.name}</b>
        <span className="mono rp-where">
          {repo.host.webUrl ? (
            <a href={repo.host.webUrl} target="_blank" rel="noreferrer">
              {repo.host.id}:{repo.remote}
            </a>
          ) : (
            `${repo.host.id}:${repo.remote}`
          )}
        </span>
        <span className="rp-tags">
          <span className="pill">в {repo.mount === "." ? "корне" : repo.mount}</span>
          <span className="pill">{repo.access === "write" ? "запись" : "чтение"}</span>
          <span className="pill">{repo.defaultBranch || "ветка не определена"}</span>
        </span>
      </div>
      {repo.host.error && <p className="pj-bad">Хостинг: {repo.host.error}</p>}
      {repo.host.problems?.map((p) => (
        <p key={p} className="pj-bad">
          Хостинг {repo.host.id}: {p}
        </p>
      ))}
      {!repo.policyValid && <p className="pj-bad">Политика не читается: пока её не исправят, агенты не получают доступа.</p>}
      {admin ? (
        <div className="pj-row">
          <select
            aria-label={`Политика ${repo.name}`}
            value={preset}
            onChange={(e) => {
              const p = PRESETS.find((x) => x.id === e.target.value);
              if (p) void changePolicy(p.policy, `${repo.name}: ${p.name.toLowerCase()}`);
            }}
          >
            {preset === "custom" && <option value="custom">{presetName("custom")}</option>}
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            aria-label={`Доступ проекта к ${repo.name}`}
            value={repo.access}
            onChange={(e) => void act(() => patch.mutateAsync({ name: repo.name, patch: { access: e.target.value as "read" | "write" } }), `${repo.name}: доступ изменён`)}
          >
            <option value="write">агенты читают и пишут</option>
            <option value="read">агенты только читают</option>
          </select>
          <button
            type="button"
            className="btn"
            disabled={check.isPending}
            onClick={() => void act(async () => setReport((await check.mutateAsync({ name: repo.name, probe })).lines))}
          >
            {check.isPending ? "Проверяю…" : "Проверить"}
          </button>
          <label className="pj-check" title="Отправить на хостинг временную ветку и удалить её: доказывает, что токен может писать">
            <input type="checkbox" checked={probe} onChange={(e) => setProbe(e.target.checked)} />
            с пробным push
          </label>
          <button type="button" className="btn ghost" disabled={sync.isPending} onClick={() => void act(() => sync.mutateAsync(repo.name), `${repo.name}: обновлено с хостинга`)}>
            Обновить
          </button>
          <button type="button" className="icon-btn" aria-label={`Отсоединить ${repo.name}`} title="Отсоединить от проекта" onClick={() => setRemoving(true)}>
            <Icon.trash size={13} />
          </button>
        </div>
      ) : (
        <p className="muted">{presetName(preset)}</p>
      )}
      <p className="pj-hint">{PRESETS.find((p) => p.id === preset)?.hint ?? "Политика задана вручную."}</p>
      {PRESETS.find((p) => p.id === preset)?.risky && <p className="pj-bad">Осторожно: основная ветка защищена только настройками самого хостинга.</p>}
      {report && (
        <ul className="pj-checks">
          {report.map((l, i) => (
            <li key={i} className={l.level}>
              <i className="lv" />
              <span className="area">{l.level === "ok" ? "ок" : l.level === "warn" ? "внимание" : "ошибка"}</span>
              <span className="txt">{l.text}</span>
            </li>
          ))}
        </ul>
      )}
      {admin && (
        <details className="rp-json" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && json === undefined && setJson(JSON.stringify(repo.policy, null, 2))}>
          <summary>Политика в JSON</summary>
          {json !== undefined && (
            <>
              <textarea aria-label={`Политика ${repo.name} в JSON`} className="mono" rows={10} value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
              <button
                type="button"
                className="btn"
                disabled={patch.isPending}
                onClick={() => {
                  let policy: RepoPolicy;
                  try {
                    policy = JSON.parse(json) as RepoPolicy;
                  } catch (e) {
                    return void act(() => Promise.reject(new Error(`Не JSON: ${e instanceof Error ? e.message : String(e)}`)));
                  }
                  void changePolicy(policy, `${repo.name}: политика сохранена`);
                }}
              >
                Сохранить политику
              </button>
              <span className="pj-hint"> Поля: read, push (none, pr_only, branches, direct), branch, branches, protected, force_push, delete_branches, change_request.</span>
            </>
          )}
        </details>
      )}
      {removing && (
        <ConfirmDialog
          title="Отсоединить репозиторий?"
          confirmLabel="Отсоединить"
          danger
          busy={remove.isPending}
          onClose={() => setRemoving(false)}
          onConfirm={() => void act(() => remove.mutateAsync(repo.name), `${repo.name} отсоединён`).then(() => setRemoving(false))}
        >
          Репозиторий останется на хостинге. Новые команды его не получат; рабочие копии действующих задач остаются на диске сервера. Пока у репозитория есть незакрытая поставка
          (открытый запрос), сервер откажет.
        </ConfirmDialog>
      )}
    </li>
  );
}

function AddRepo({ hosts, problems, loaded }: { hosts: string[]; problems: string[]; loaded: boolean }) {
  const add = useAddRepo();
  const act = useAct();
  const empty = { name: "", host: "", remote: "", mount: ".", access: "write" as "read" | "write", preset: "pr-human" };
  const [f, setF] = useState(empty);
  return (
    <>
      <h3 className="pj-sub">Добавить репозиторий</h3>
      {loaded && hosts.length === 0 && (
        <p className="pj-bad">
          В <span className="mono">git.json</span> нет ни одного хостинга. Опишите его (адрес и токен) и обновите страницу — пример в docs/platform/git-repositories.md.
        </p>
      )}
      {problems.map((p) => (
        <p key={p} className="pj-bad">
          git.json: {p}
        </p>
      ))}
      <form
        className="pj-row"
        onSubmit={(e) => {
          e.preventDefault();
          const preset = PRESETS.find((p) => p.id === f.preset);
          void act(
            async () => {
              const r = await add.mutateAsync({ name: f.name.trim(), host: f.host, remote: f.remote.trim(), mount: f.mount.trim() || ".", access: f.access, policy: preset?.policy });
              if (r.warning) throw new Error(`Добавлен, но хостинг не ответил: ${r.warning}`);
            },
            `${f.name.trim()} добавлен`,
          ).then((ok) => ok && setF(empty));
        }}
      >
        <input aria-label="Имя в проекте" placeholder="имя (api)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required pattern="[a-z0-9][a-z0-9_-]*" />
        <select aria-label="Хостинг" value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} required>
          <option value="">Хостинг…</option>
          {hosts.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
        <input aria-label="Путь на хостинге" placeholder="группа/подгруппа/репозиторий" value={f.remote} onChange={(e) => setF({ ...f, remote: e.target.value })} required />
        <input aria-label="Где лежит в проекте" placeholder="путь в проекте (.)" value={f.mount} onChange={(e) => setF({ ...f, mount: e.target.value })} />
        <select aria-label="Доступ агентов" value={f.access} onChange={(e) => setF({ ...f, access: e.target.value as "read" | "write" })}>
          <option value="write">читают и пишут</option>
          <option value="read">только читают</option>
        </select>
        <select aria-label="Политика" value={f.preset} onChange={(e) => setF({ ...f, preset: e.target.value })}>
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button className="btn primary" disabled={add.isPending || !f.host}>
          Добавить
        </button>
      </form>
    </>
  );
}
