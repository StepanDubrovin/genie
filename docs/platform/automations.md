---
title: Автоматизации genie — модель правил, запусков и агентных заданий
summary: Проект модели автоматизаций для genie server: триггеры, условия, шаги (детерминированные, агентные, ожидание), долговечные запуски, бюджеты и защита от каскадов, с примерами «задача готова → документация + чейнджлог + уведомления» и «новая задача → аналитики → вопросы менеджеру в Telegram».
type: note
status: draft
tags: [платформа, автоматизации, триггеры, агенты, каналы]
aliases: [automations, triggers, rules, playbooks, workflows]
paths: [src/tracker/store.ts, src/team/ops.ts, src/team/spawn.ts, src/notify.ts]
---

# Автоматизации genie

Контекст — [[platform/vision]]. Автоматизации строятся поверх журнала событий (раздел «Журнал событий» там же) и очереди заданий.

## Понятия

| Понятие | Что это |
|---|---|
| **Правило** (`automation`) | Версионируемое описание: триггер, условия, шаги, лимиты, владелец. Включается/выключается, имеет режим `dry-run` |
| **Триггер** | Что запускает правило: событие журнала с фильтром, расписание (cron), входящий webhook, сообщение в канале, ручной запуск кнопкой |
| **Запуск** (`automation_run`) | Одно исполнение правила на одно событие. Долговечное: переживает рестарт сервера, шаги продолжаются с места остановки |
| **Шаг** (`run_step`) | Действие внутри запуска со своим статусом, выходом, ретраями и стоимостью |
| **Агентное задание** (`agent_job`) | Разовый запуск роли (или команды по шаблону) с целью, входами и ожидаемым выходом; результат — артефакты, изменения в git, ответ в структурированном виде |
| **Опросник** (`questionnaire`) | Вопросы от агента конкретному человеку через канал; у каждого вопроса свой ответ и статус |
| **Плейбук** | Готовое правило из библиотеки (шаблон с параметрами), которое включается в проекте в два клика |

## Триггеры

```yaml
on:
  event: task.status_changed          # любой тип из журнала
  where:                              # фильтр по payload, без кода
    to: done
    task.type: [task, bug]
    task.labels: { not_contains: no-docs }
# или
on: { schedule: "0 9 * * 1-5", tz: Europe/Moscow }
# или
on: { webhook: github, where: { action: closed, pull_request.merged: true } }
# или
on: { channel: telegram, where: { chat: product, command: /task } }
# или
on: { manual: true, inputs: { task: task_id } }
```

Фильтр — декларативный (равенство, списки, `contains`, `not_*`, сравнения для чисел и дат), чтобы правило было понятно человеку в UI и проверяемо без исполнения кода. Для редких случаев — условие-выражение (`if:`) на ограниченном языке (CEL или JSONata), без доступа к сети и файлам.

## Шаги

| Шаг | Что делает | Пример |
|---|---|---|
| `task.update` / `task.status` / `task.comment` / `task.create` | Операции трекера от имени правила (актор `automation:<id>`) | перевести в `refining`, создать подзадачу |
| `agent` | Разовое агентное задание: роль, модель, цель, входы, формат выхода, рабочая копия (`none` / `read-only` / `worktree`) | документатор собирает артефакты в docs |
| `team` | Собрать фокус-команду по шаблону (`team_spawn`) | команда `research` для новой задачи |
| `wake_orchestrator` | Письмо оркестратору с контекстом | «задача висит в `needs_owner` 2 дня» |
| `notify` | Сообщение людям через каналы по шаблону | владельцам и наблюдателям задачи |
| `ask` | Отправить опросник и **ждать** ответов (с таймаутом и напоминаниями) | вопросы менеджеру в Telegram |
| `changelog.add` | Запись в `Unreleased` (раздел, текст, ссылка на задачу) | «Исправлено: …» |
| `docs.propose` | Изменения в `docs/` веткой/PR или сразу в main по политике пространства | обновить страницу процесса |
| `git.pr` / `git.merge` | Работа с веткой команды через интеграцию хостинга | PR на `review`, merge на `done` |
| `http` | Исходящий webhook | Slack, внешняя CRM |
| `wait` | Ждать события/времени | «если за 24 ч не ответили — напомнить» |

У каждого шага: `id`, `if` (условие по выходам предыдущих шагов), `retry` (кол-во, backoff), `timeout`, `on_error` (`fail` | `continue` | `notify`). Выход шага доступен дальше как `steps.<id>.output`.

### Агентное задание

```yaml
- id: docs
  agent:
    role: documenter
    model: default                    # или конкретная модель; иначе roleModels проекта
    goal: >
      Turn the task's artifacts into durable project documentation.
      Update existing pages instead of creating a page per task.
    inputs:
      task: "{{ event.task.id }}"
      include: [description, acceptance, artifacts, decisions, review]
    workspace: worktree               # none | read-only | worktree
    output:
      schema:                         # структурированный ответ, валидируется
        pages_changed: string[]
        summary: string
        changelog: { section: enum[Added, Changed, Fixed], text: string }
    budget: { usd: 0.50, minutes: 15 }
```

Реализация — тот же механизм, что у участника команды (pi-процесс с ролью, промптом роли, `genie_task`, `docs_*`), но с жизненным циклом «запустился → выполнил цель → отдал структурированный выход → завершился». Выход фиксируется артефактом задачи, так что результат виден в карточке, а не только в журнале запуска.

## Пример 1. Задача готова → документация, чейнджлог, уведомления

```yaml
name: Задача закрыта — знания и чейнджлог
on:
  event: task.status_changed
  where: { to: done, task.type: [task, bug] }
limits: { concurrency: 2, budget_usd_per_day: 5 }
steps:
  - id: docs
    agent:
      role: documenter
      goal: Consolidate the task's artifacts into the project docs (update existing pages, add links back to the task, refresh `verified`).
      inputs: { task: "{{ event.task.id }}" }
      workspace: worktree
      output: { schema: { pages_changed: string[], summary: string, changelog: { section: string, text: string } } }
  - id: publish
    docs.propose:
      from: docs
      policy: space                  # по политике пространства: PR на ревью или сразу в main
  - id: log
    changelog.add:
      section: "{{ steps.docs.output.changelog.section }}"
      text: "{{ steps.docs.output.changelog.text }}"
      task: "{{ event.task.id }}"
  - id: tell
    notify:
      to: [task.owner, task.watchers, epic.owner]
      channels: preferred             # у каждого получателя — свой канал по настройкам
      template: task_done
      with:
        summary: "{{ steps.docs.output.summary }}"
        pages: "{{ steps.docs.output.pages_changed }}"
```

Что видит команда: в карточке задачи — артефакт «Документация обновлена» со списком страниц и ссылкой на PR; в `CHANGELOG.md` → `Unreleased` — строка со ссылкой на задачу; у владельцев — одно сообщение в Telegram/почте с итогом и кнопкой «Открыть».

## Пример 2. Новая задача от продакта → аналитики → вопросы в Telegram

```yaml
name: Разбор новой задачи
on:
  event: task.created
  where: { task.status: inbox, actor.project_role: [owner, admin, member] }
steps:
  - id: take
    task.status: { to: refining, note: "Взята в разбор автоматически" }
  - id: analyse
    team:
      template: research              # analyst + reviewer, без worktree
      goal: >
        Analyse the task, draft scope and acceptance criteria, and list the questions
        only the author can answer. Do not guess answers to product questions.
      output: { schema: { questions: { text: string, why: string, options?: string[] }[], draft_ac: string[] } }
  - id: ask
    if: "{{ steps.analyse.output.questions | length > 0 }}"
    ask:
      to: event.actor                 # автор задачи
      channel: preferred              # Telegram, если привязан; иначе почта
      questions: "{{ steps.analyse.output.questions }}"
      remind_after: 24h
      timeout: 72h
      on_timeout: needs_owner         # задача уходит в «Нужно решение»
  - id: continue
    wake_orchestrator:
      text: "Answers for {{ event.task.id }} arrived; finish refinement and move to ready if DoR is met."
```

Как выглядит для менеджера: через несколько минут после создания задачи в Telegram приходит «G-42 · 3 вопроса от аналитиков» — по сообщению на вопрос, с вариантами-кнопками, где они есть. Ответ (кнопкой, текстом или голосовым после транскрипции) сразу пишется в задачу комментарием `owner`, а когда отвечены все вопросы, оркестратор завершает уточнение.

## Библиотека плейбуков (первая версия)

| Плейбук | Триггер | Что делает |
|---|---|---|
| Разбор новой задачи | `task.created` во входящих | пример 2 |
| Знания и чейнджлог | `task.status_changed → done` | пример 1 |
| Эскалация решения | `needs_owner` дольше N часов | напоминание адресату, затем владельцу проекта |
| CI упал на ветке команды | `ci.failed` | письмо исполнителю команды `high`/`blocker` с логом |
| PR смёрджен | `git.pr_merged` | задача → `done` (если `approved`), остановка команды |
| Устаревшая документация | расписание, еженедельно | задачи на актуализацию страниц с меткой «возможно устарела» |
| Утренний дайджест | расписание, будни 9:00 | каждому участнику: что ждёт его, что закрыто, что застряло |
| Релиз | ручной запуск | `Unreleased` → версия, тег, заметки о выпуске в каналы |
| Эпик закрыт | `epic.progress` = 100% | документатор пишет обзор эпика, уведомление стейкхолдерам |

## Надёжность и безопасность

- **Ровно один запуск на событие**: ключ идемпотентности `(automation_id, version, event_id)`; повторная доставка события не создаёт второй запуск.
- **Долговечность**: запуск и шаги в БД; после рестарта сервер продолжает `pending`/`waiting` шаги. Агентные задания переподключаются тем же механизмом, что `team_recover`.
- **Каскады**: событие несёт `cause` (цепочку запусков); глубина > 3 или повтор того же правила в цепочке — запуск не создаётся, в журнале — пометка. Действия правила по умолчанию не триггерят то же правило.
- **Бюджеты**: на правило (в день/месяц) и на проект; превышение останавливает новые запуски и уведомляет владельца. Каждый шаг пишет токены и стоимость.
- **Права**: правило исполняется от актора `automation:<id>` с правами, не превышающими права его автора; менять автоматизации могут owner/admin.
- **Недоверенный ввод**: текст из каналов и webhooks передаётся агентам как данные с пометкой источника; шаги, меняющие права, секреты или удаляющие данные, в правилах с внешним триггером запрещены.
- **Наблюдаемость**: экран «Запуски» — лента с фильтрами (правило, задача, статус), граф шагов с входами/выходами/стоимостью, кнопки «повторить шаг», «остановить», «открыть задачу»; `dry-run` показывает, что сделало бы правило на прошлых событиях.

## Модель данных (набросок)

```
automations(id, project, name, version, enabled, dry_run, spec JSON, created_by, created, updated)
automation_runs(id, automation, version, event_id, status, cause JSON, started, finished, cost_usd, error)
run_steps(id, run, step_id, status, attempt, input JSON, output JSON, started, finished, cost_usd, error)
agent_jobs(id, run_step, project, task, role, model, runtime JSON, session_file, status, output JSON, cost_usd)
questionnaires(id, project, task, asked_by, recipient_user, channel, status, due, created)
questions(id, questionnaire, n, text, why, options JSON, answer, answered_by, answered_at, channel_message_ref)
subscriber_cursors(subscriber, last_event_id)
```

Статусы запуска: `queued → running → waiting → succeeded | failed | cancelled | skipped (dry-run/лимит)`.
