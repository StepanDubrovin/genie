# genie

**Командный сервис задач, знаний и команд ИИ-агентов.** Люди ставят задачи в веб, Telegram или почту; оркестратор уточняет их и собирает под каждую фокус-команду агентов (аналитик, исполнитель, ревьюер, тестировщик, документатор — у каждого своя модель); команда работает в своём git worktree или, для проектов без кода, в своём каталоге, а когда нужно решение человека — спрашивает ответственного. Знания — Obsidian-совместимое хранилище в git, которое правят и люди, и агенты.

- **Сервер** `genie serve` (Rust): веб-интерфейс в духе Linear, API, живые сессии агентов на [pi](https://pi.dev) в песочнице bubblewrap, роли и шаблоны команд, шлюз MCP, автоматизации, уведомления в веб, Telegram и почту, база знаний с синхронизацией в git.
- **Люди и проекты**: несколько проектов, роли в проекте, ответственные за задачи, упоминания `@login`, приглашения ссылкой; автономность оркестратора на проект (`autonomous`, `assisted`, `manual`).
- **Надёжность**: перезапуск ничего не теряет, резервная копия на ходу, `genie doctor` перед запуском, юниты systemd.
- **Эпики**: большую работу оркестратор оформляет эпиком — цель, критерии успеха, дорожная карта и общие артефакты (требования, глоссарий, решения) живут в эпике; его задачи видят цель и артефакты, эпик сам считает прогресс.
- **Картинки**: артефакт-картинка (PNG, JPEG, GIF, WebP) получает миниатюру и лайтбокс с зумом; в чате команды — `!image[artifact:G-7/3]` или `!image[docs/shot.png]` (файл рабочей копии команды), внешние URL не поддерживаются.

## Быстрый старт

```bash
npm install && npm run build:web && cargo build --release -p genie   # веб встраивается в бинарь
npm install -g @earendil-works/pi-coding-agent && pi          # pi и /login у провайдеров моделей
./target/release/genie serve                                    # http://127.0.0.1:7420
```

Откройте веб на этой же машине: сервер без проектов предложит создать первый, на странице «Проект и люди» — учётную запись администратора и ссылки-приглашения для коллег. `./target/release/genie doctor` скажет, чего ещё не хватает (модели ролей, песочница, каналы, сеть).

**В Docker** (сервер одним образом: genie + веб + pi + git):

```bash
cp .env.example .env && docker compose up -d --build
echo 'пароль' | docker compose exec -T genie genie user add admin --admin --password-stdin
```

Тома, репозитории, ключи моделей, git-доступ, прокси, готовый образ из GHCR и бэкапы — [docs/platform/docker.md](docs/platform/docker.md).

## Документация

- [Запуск и эксплуатация](docs/platform/getting-started.md) — люди, агенты, песочница, роли и шаблоны, Telegram и почта, знания и Obsidian, резервные копии, systemd, `genie doctor`.
- [Пилот](docs/platform/pilot.md) — подготовка, репетиция, первый день, что измерять.
- [Видение](docs/platform/vision.md), [бэкенд](docs/platform/backend.md), [роли и команды](docs/platform/agent-roles-and-teams.md), [шина агентов](docs/platform/agent-bus.md), [база знаний](docs/platform/knowledge-vault.md), [автоматизации](docs/platform/automations.md), [решения](docs/platform/decisions.md).
- [CHANGELOG](CHANGELOG.md).

## Разработка

```bash
cargo test                   # ядро, API, рантайм агентов (в том числе живые сессии pi и песочница), сценарии владельца
cargo clippy --all-targets -- -D warnings && cargo fmt --all --check
npm test && npm run typecheck && npm run build:web
npm run dev:web              # Vite с проксированием /api на сервер (порт 7420)
# Типы API для веба генерируются из Rust-структур: после их изменения — cargo test и коммит web/src/shared/api/generated.
```

## Переход с расширения pi

Первая версия genie — расширение pi с локальным трекером (`pi install …/genie`, `/genie` в pi, `genie web`) — удалена: genie теперь сервер. Задачи репозитория переезжают на месте: `genie project add shop --repo ~/projects/my-repo` подключает его `.genie/` со всеми задачами и номерами. Ваша сессия pi становится оркестратором проекта командой `genie orchestrate`, другие агенты (Claude Code, Codex…) получают инструменты genie через MCP-сервер. По шагам — [docs/platform/getting-started.md](docs/platform/getting-started.md#переход-с-расширения-pi).
