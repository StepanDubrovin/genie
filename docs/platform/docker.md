---
title: Genie server в Docker
summary: Как запустить genie server в контейнере на сервере — образ, compose, тома, пользователи и права, модели и ключи, git-доступ, обратный прокси, остановка, бэкапы, обновление и разбор типичных сбоев.
type: runbook
status: current
tags: [платформа, docker, запуск, эксплуатация, runbook]
aliases: [docker, контейнер, compose, образ]
paths: [Dockerfile, docker-compose.yml, docker/**, .env.example, .dockerignore]
verified: 2026-09-29
---

# Genie server в Docker

Обычный запуск без контейнера — [[platform/getting-started]]. Здесь то же самое для сервера: один образ, один `docker compose up`.

## Что внутри образа

| Слой | Зачем |
|---|---|
| `genie` (Rust, release) | сервер, CLI, встроенные роли, шаблоны и расширения pi |
| `web/dist` | веб-интерфейс |
| Node 24 + **pi** (версия зафиксирована `PI_VERSION`) | харнесс агентов: по процессу `pi --mode rpc` на агента |
| `pi-mcp-adapter` | подключения MCP для ролей; регистрируется в настройках pi при старте |
| git, ssh, ripgrep, jq, curl, procps | всё, чем пользуются агенты и сам сервер (`kill`, worktree, vault) |
| tini | PID 1: подбирает завершённые процессы агентов, пересылает сигналы |

Тома:

- `/data` — данные сервера (`GENIE_DATA`) и **`HOME` пользователя**: `server.db`, трекеры проектов, vault, сессии агентов, `config.json`, а также `~/.pi/agent` (ключи и провайдеры pi), `~/.ssh`, `~/.gitconfig`. Один том — одна резервная копия.
- `/workspace` — git-репозитории проектов и рядом их worktree команд (`<repo>.worktrees/<команда>`).

Сервер и агенты работают от пользователя `genie` (uid/gid 1000 по умолчанию), не от root.

## Быстрый старт

```bash
git clone https://github.com/grigoryshulga/genie.git && cd genie
cp .env.example .env            # ключи моделей, публичный адрес — см. ниже
docker compose up -d --build    # первая сборка — несколько минут (Rust)

# ВАЖНО: до того как открывать порт наружу
echo 'пароль-не-короче-8' | docker compose exec -T genie genie user add admin --admin --password-stdin
```

Откройте http://127.0.0.1:7420 и войдите. Пока в системе нет ни одного пользователя, сервер пускает без входа только запросы с loopback внутри контейнера; из-за проброса порта запросы с хоста приходят с адреса моста Docker и получают «нужен вход». Но лучше не полагаться на это и создавать администратора сразу.

`docker compose exec genie genie …` запускает CLI от пользователя сервера (обёртка `/usr/local/bin/genie`): файлы в `/data` не станут принадлежать root. Любая другая команда через `docker exec` стартует от root — добавляйте `-u genie`.

## Настройка

Все переменные — в `.env.example`. Главное:

| Переменная | Назначение |
|---|---|
| `GENIE_PORT` | порт веба, **одинаковый** снаружи и внутри: сервер сверяет заголовок `Host` со своим портом |
| `GENIE_PUBLIC_URL` | адрес для ссылок в письмах и Telegram; его хост автоматически попадает в `allowHosts` |
| `GENIE_ALLOW_HOSTS` | другие имена и адреса, по которым открывают UI (`192.168.1.20,genie.lan`) |
| `GENIE_UID`, `GENIE_GID` | uid/gid сервера; ставьте владельца смонтированных репозиториев (`id -u`) |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, … | ключи провайдеров для pi |
| `GITHUB_TOKEN` | HTTPS-доступ агентов к github.com |
| `EXTRA_APT_PACKAGES` | пакеты, добавляемые в образ при сборке (компиляторы, python…) |

Переменные `GENIE_BIND`, `GENIE_PUBLIC_URL` и `GENIE_ALLOW_HOSTS` при каждом старте записываются в `/data/config.json` (только эти ключи; `allowHosts` дополняется, ничего не удаляется). Остальное содержимое `config.json` — ваше: модели ролей, лимиты, Telegram, SMTP — см. [[platform/getting-started]]. Сервер читает настройки только из этого файла, поэтому править его удобно так:

```bash
docker compose exec genie sh -c 'cat /data/config.json'
docker compose cp config.json genie:/data/config.json && docker compose restart genie
```

Пример `config.json` с моделями ролей:

```json
{
  "roleModels": {
    "analyst":  { "model": "anthropic/claude-opus-5-5", "thinking": "high" },
    "executor": { "model": "anthropic/claude-sonnet-5-5", "thinking": "high" },
    "reviewer": { "model": "anthropic/claude-opus-5-5", "thinking": "high" }
  },
  "runtime": { "maxSessions": 6 }
}
```

Встроенные значения по умолчанию (`config/default.json`) ссылаются на провайдеры `litellm/…` и `openai-codex/…`: без соответствующих настроек pi агентам они недоступны. Задайте свои модели или положите `models.json`/`auth.json` в `/data/home/.pi/agent`.

## Модели и pi

pi берёт ключи из переменных окружения (список — в документации pi, `providers.md`) или из `~/.pi/agent/auth.json`. Свои провайдеры (например, LiteLLM) описываются в `~/.pi/agent/models.json`:

```bash
docker compose cp models.json genie:/data/home/.pi/agent/models.json
docker compose exec -u genie genie chmod 600 /data/home/.pi/agent/models.json
```

Вход по OAuth (`/login`) в контейнере неудобен: используйте API-ключи или скопируйте `auth.json`, полученный на другой машине.

Образ выключает проверку версий pi и его телеметрию (`PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0`); переопределяется в `.env`.

Доверие к проектным ресурсам pi (`defaultProjectTrust`) остаётся по умолчанию: не интерактивный запуск не загружает расширения из `.pi/` репозитория. Навыки роли genie передаёт агенту явно.

## LiteLLM и секреты

Готовая конфигурация под LiteLLM — в `docker/examples/litellm/`:

- `models.json` — провайдер `litellm` для pi; ключ берётся из переменной окружения (`"apiKey": "$LITELLM_API_KEY"`), в файле его нет. Адрес `baseUrl` замените на свой: LiteLLM на самом хосте доступен из контейнера как `host.docker.internal` (в `docker-compose.yml` он уже прописан), `localhost` внутри контейнера — это сам контейнер.
- `config.json` — `roleModels` для всех ролей на `litellm/…`. Встроенные значения по умолчанию ссылаются ещё и на `openai-codex/…` и `litellm/claude-opus-5-5`, поэтому набор моделей нужно задать явно. В примере аналитик, ревьюер, оркестратор и исследователь — `gpt-6-sol`, исполнитель, тестер и документатор — `gpt-6-luna`; подставьте свои.

```bash
docker compose cp docker/examples/litellm/models.json genie:/data/home/.pi/agent/models.json
docker compose exec -u genie genie sh -c 'chmod 600 ~/.pi/agent/models.json'
# roleModels: добавьте содержимое config.json в /data/config.json и перезапустите
docker compose restart genie
```

Ключ передаётся серверу, агенты pi наследуют его:

```bash
# вариант 1: переменная окружения (.env)
LITELLM_API_KEY=sk-…

# вариант 2: Docker secret (файл), ключ не попадает в .env и в `docker inspect`
mkdir -p secrets && chmod 700 secrets && printf '%s' 'sk-…' > secrets/litellm_api_key && chmod 600 secrets/litellm_api_key
docker compose -f docker-compose.yml -f docker-compose.secrets.yml up -d
```

Для любой переменной вида `*_API_KEY`, `*_TOKEN`, `*_PASSWORD`, `*_SECRET` работает суффикс `_FILE`: `GITHUB_TOKEN_FILE=/run/secrets/github` превращается в `GITHUB_TOKEN`, прочитанный из файла (пробельный хвост отбрасывается). Явно заданная переменная приоритетнее файла. Файл читается на старте от root, поэтому права `0400` не мешают. Так же передаются секреты MCP-серверов из `mcp.json` (`${env:JIRA_API_TOKEN}` → `JIRA_API_TOKEN_FILE`): сервер держит их у себя, а агентам не отдаёт, если подключение идёт через шлюз (см. [[platform/getting-started]]).

Проверено сквозным тестом с поддельным LiteLLM на хосте: оркестратор стартует на `litellm/gpt-6-sol`, запрос уходит на `host.docker.internal` с `Authorization: Bearer <ключ из файла>`, ответ доходит до сессии.

Локальную обёртку с Bitwarden Secrets Manager в образ переносить не нужно: `secret-tool` и keyring в контейнере нет. Секрет достаёт инфраструктура (Docker secret, оркестратор, `bws run -- docker compose up`), а контейнер получает готовое значение.

## Репозитории проектов

Два способа.

**1. Клонировать внутрь тома** (проще всего для сервера):

```bash
docker compose exec -u genie genie git clone git@github.com:acme/shop.git /workspace/shop
docker compose exec genie genie project add shop --name "Магазин" --repo /workspace/shop
```

**2. Смонтировать существующий каталог.** Монтируйте **родительский** каталог и делайте владельцем `GENIE_UID`: worktree команды создаётся рядом с репозиторием (`{mainRoot}/../{repo}.worktrees/…`), а не внутри него.

```yaml
    volumes:
      - ${HOME}/code:/workspace/code      # проект: --repo /workspace/code/shop
```

Пути внутри `worktree` git хранит абсолютными: если тот же репозиторий открыт и на хосте, его worktree'ы, созданные контейнером, на хосте выглядят сломанными. Для серверного сценария держите репозиторий в томе контейнера и работайте с ним через git remote.

### Доступ к git-серверу

- **GitHub по HTTPS.** Задайте `GITHUB_TOKEN` (или `GH_TOKEN`; fine-grained токен на нужные репозитории, права Contents: read/write). Системный credential helper (`/etc/gitconfig`) подставляет его только для `https://github.com` и читает из окружения контейнера в момент использования: на диск токен не пишется, работает и у агентов, и в оболочке `docker exec`. Агенты видят токен в своём окружении.
- **SSH.** Положите ключ в `/data/home/.ssh` (`id_ed25519`, права 600; каталог получит 700 при старте). Неизвестные хосты принимаются при первом подключении (`StrictHostKeyChecking accept-new`), запросов пароля нет.
- **Автор коммитов.** По умолчанию `genie <genie@genie.local>`; меняется `GIT_AUTHOR_NAME/EMAIL` и `GIT_COMMITTER_NAME/EMAIL` в `.env`.

## Инструменты для проектов

Агенты запускают сборку и тесты вашего кода внутри контейнера, поэтому нужные компиляторы должны быть в образе. Два способа:

```bash
# в .env; пакеты Debian
EXTRA_APT_PACKAGES="python3 python3-venv build-essential"
```

или свой образ поверх:

```dockerfile
FROM genie:latest
USER root
RUN apt-get update && apt-get install -y --no-install-recommends golang && rm -rf /var/lib/apt/lists/*
```

(Точка входа сама переключается на пользователя `genie`, `USER` менять не нужно.)

## Обратный прокси и TLS

Порт публикуется на `127.0.0.1`. Для доступа по сети поставьте перед ним Caddy, Traefik или nginx с TLS и задайте `GENIE_PUBLIC_URL=https://genie.example.com`. Прокси должен пробрасывать заголовок `Host` без изменений и не буферизовать поток событий (`/api/…` использует долгоживущие ответы).

```caddyfile
genie.example.com {
  reverse_proxy 127.0.0.1:7420
}
```

Если открыть UI по адресу, которого нет в `allowHosts`, сервер отвечает `421 unexpected Host header`. Так же бывает, если порт снаружи отличается от `GENIE_PORT`.

## Остановка, перезапуск, здоровье

- Контейнер останавливается сигналом `SIGINT` (`STOPSIGNAL` в образе, `stop_signal` в compose); `SIGTERM` сервер тоже обрабатывает. Открытые запросы получают 5 секунд, после чего сервер выходит, даже если браузер держит поток событий: проверено с открытой вкладкой — остановка занимает около 5 секунд и завершается кодом 0. `stop_grace_period` — 20 секунд с запасом.
- PID 1 — tini от имени пользователя `genie`: он подбирает завершённые процессы агентов и пересылает сигналы. Начальный этап (владелец томов, uid) выполняется от root и заканчивается до запуска tini, поэтому после старта в контейнере нет процессов root.
- Перезапуск безопасен: прерванные ходы агентов повторяются, письма возвращаются (см. [[platform/getting-started]], «Надёжность»).
- `HEALTHCHECK` опрашивает `/api/health`; `docker compose ps` показывает `healthy`.
- Логи: `docker compose logs -f genie` (ротация 10 МБ × 5). Журналы ходов агентов — в `/data/runtime/<проект>/<агент>/`.

## Резервные копии и обновление

```bash
# копия баз (VACUUM INTO) и vault на хосте
docker compose exec -u genie genie genie backup /data/backups
docker compose cp genie:/data/backups ./backups
```

Копия не содержит `~/.pi/agent`, `~/.ssh` и репозитории в `/workspace`: их сохраняйте отдельно (снимок тома или `docker run --rm -v genie_genie-data:/d -v "$PWD":/b alpine tar czf /b/genie-data.tgz -C /d .`).

Обновление:

```bash
git pull
docker compose up -d --build
```

Данные на томах сохраняются; схема баз мигрирует сервером при старте.

## Что нужно знать о безопасности

- Агенты выполняют произвольные shell-команды и работают под тем же пользователем, что и сервер: они **могут прочитать `/data`**, включая `server.db` и `config.json` (токен Telegram, пароль SMTP). Контейнер — граница между агентами и хостом, но не между агентами и сервером. Не храните в `/data` ничего, что нельзя доверить агентам; для GitHub используйте токен с минимальными правами.
- Ключи провайдеров в `.env` попадают в окружение агентов. Используйте ключи с лимитом расходов.
- Контейнер запущен с `no-new-privileges`, `cap_drop: ALL` и пятью capabilities только для стартового этапа от root (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETUID`, `SETGID`): сервер и агенты работают без capabilities (`CapEff` = 0), плюс лимит процессов. Ограничьте память (`GENIE_MEM_LIMIT`): каждая живая сессия агента — процесс Node на сотни мегабайт (`runtime.maxSessions`, по умолчанию 12).
- Не публикуйте порт на `0.0.0.0` без TLS-прокси и без созданного администратора.
- Файловые системы: SQLite в режиме WAL требует локального диска или именованного тома; NFS и SMB для `/data` не подходят.

## Типичные проблемы

| Симптом | Причина и решение |
|---|---|
| `/data is not writable by uid …` | том принадлежит другому uid: запускайте контейнер от root (по умолчанию) и задайте `GENIE_UID`/`GENIE_GID`, либо `chown` тома |
| Страница не открывается, `421 unexpected Host header` | адрес не в `allowHosts` или порт снаружи не равен `GENIE_PORT` |
| Порт отвечает «connection reset» | в `config.json` явно задан `bind: 127.0.0.1` (предупреждение в логе при старте) |
| `fatal: detected dubious ownership` | не должно возникать (`safe.directory = *`); проверьте, что репозиторий смонтирован, а не скопирован с чужим `.git` |
| `Permission denied (publickey)` при `git clone` | нет ключа в `/data/home/.ssh` или права не 600 |
| Агент не стартует, в `stderr.log` ошибка модели | нет ключа провайдера или у роли (`roleModels`) указана недоступная модель |
| `docker compose exec genie …` создал файлы root | добавляйте `-u genie`; `genie …` сам понижает права |
| Сборка падает на `apt-get update` или `npm ci` / `cargo build` с ошибкой сертификата | сборщику закрыт доступ к зеркалам Debian, npm и crates.io либо трафик перехватывает корпоративный прокси: настройте прокси Docker и добавьте корневой сертификат в образ |
| `docker compose stop` занимает 20 секунд | контейнер собран из старой версии образа без обработки SIGTERM/долгих соединений: пересоберите (`up -d --build`) |
