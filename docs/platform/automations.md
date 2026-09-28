---
title: Автоматизации genie — модель правил, запусков и агентных заданий
summary: Проект модели автоматизаций для сервера genie — триггеры, условия, шаги (детерминированные, агентные, ожидание ответа), долговечные запуски, лимиты и защита от каскадов, с примерами «задача закрыта → знания в vault + чейнджлог + уведомления» и «новая задача → аналитики → вопросы менеджеру в Telegram».
type: note
status: draft
tags: [платформа, автоматизации, триггеры, агенты, каналы]
aliases: [automations, triggers, rules, playbooks, workflows]
---

# Автоматизации genie

Контекст — [[platform/vision]]. Автоматизации строятся поверх журнала событий и очереди заданий сервера ([[platform/backend]]). Расходы на модели ограничивает корпоративный провайдер (PD7 в [[platform/decisions]]), поэтому ниже — только лимиты поведения.

## Понятия

| Понятие | Что это |
|---|---|
| **Правило** (`automation`) | Версионируемое описание: триггер, условия, шаги, лимиты, владелец. Включается и выключается, есть режим `dry-run` |
| **Триггер** | Что запускает правило: событие журнала с фильтром, расписание (cron), входящий webhook, сообщение в канале, ручной запуск кнопкой |
| **Запуск** (`automation_run`) | Одно исполнение правила на одно событие. Долговечный: переживает рестарт сервера, шаги продолжаются с места остановки |
| **Шаг** (`run_step`) | Действие внутри запуска со своими статусом, выходом и повторами |
| **Агентное задание** (`agent_job`) | Разовый запуск роли (или команды по шаблону) с целью, входами и ожидаемым выходом; результат — артефакты, изменения в vault или коде, структурированный ответ |
| **Опросник** (`questionnaire`) | Вопросы от агента конкретному человеку через канал; у каждого вопроса свой ответ и статус |
| **Плейбук** | Готовое правило из библиотеки (шаблон с параметрами), включается в проекте в два клика |

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
on: { webhook: forms, where: { form: bug-report } }
# или
on: { channel: telegram, where: { chat: product, command: /task } }
# или
on: { manual: true, inputs: { task: task_id } }
```

Фильтр декларативный (равенство, списки, `contains`, `not_*`, сравнения чисел и дат): правило понятно человеку в UI и проверяется без исполнения кода. Для редких случаев есть условие `if:` на ограниченном языке выражений (CEL или JSONata) без доступа к сети и файлам.

## Шаги

| Шаг | Что делает | Пример |
|---|---|---|
| `task.update` / `task.status` / `task.comment` / `task.create` | Операции трекера от имени правила (актор `automation:<id>`) | перевести в `refining`, создать подзадачу |
| `agent` | Разовое агентное задание: роль, модель, цель, входы, формат выхода, рабочее место | документатор переносит артефакты задачи в vault |
| `team` | Собрать фокус-команду по шаблону (`team_spawn`) | команда `research` для новой задачи |
| `wake_orchestrator` | Письмо оркестратору с контекстом | «задача висит в `needs_owner` два дня» |
| `notify` | Сообщение людям через каналы по шаблону | владельцам и наблюдателям задачи |
| `ask` | Отправить опросник и **ждать** ответов (с напоминаниями и таймаутом) | вопросы менеджеру в Telegram |
| `vault.propose` | Изменения в vault по политике раздела: сразу коммит или предложение на ревью ([[platform/knowledge-vault]]) | обновить страницу процесса |
| `changelog.add` | Запись в `Unreleased` чейнджлога проекта в vault | «Исправлено: …» |
| `http` | Исходящий webhook | Slack, внешняя CRM |
| `wait` | Ждать события или времени | «если за 24 ч нет ответа — напомнить» |
| `git.pr` / `git.merge` | Работа с веткой команды через git-хостинг (после MVP, Ф6) | PR на `review`, merge на `done` |

У каждого шага есть `id`, `if` (условие по выходам предыдущих шагов), `retry` (число попыток и пауза), `timeout`, `on_error` (`fail` | `continue` | `notify`). Выход шага доступен дальше как `steps.<id>.output`.

### Агентное задание

```yaml
- id: docs
  agent:
    role: documenter
    model: default                    # или конкретная модель; иначе roleModels проекта
    goal: >
      Turn the task's artifacts into durable project knowledge in the vault.
      Update existing pages instead of creating a page per task.
    inputs:
      task: "{{ event.task.id }}"
      include: [description, acceptance, artifacts, decisions, review]
    workspace: read-only              # none | read-only | worktree | scratch
    output:
      schema:                         # структурированный ответ, валидируется
        pages_changed: string[]
        summary: string
        changelog: { section: enum[Added, Changed, Fixed], text: string }
    limits: { minutes: 15 }
```

Рабочее место: `none` — только инструменты genie (задачи, vault); `read-only` — копия репозитория проекта только для чтения; `worktree` — своя ветка, как у команды; `scratch` — пустой рабочий каталог, например для проектов без кода.

Задание запускается тем же механизмом, что и участник команды: pi-процесс с промптом роли и инструментами genie через MCP. Но жизненный цикл у него короткий: запустилось → выполнило цель → отдало структурированный выход → завершилось. Выход сохраняется артефактом задачи, поэтому результат виден в карточке, а не только в журнале запуска.

## Пример 1. Задача закрыта → знания, чейнджлог, уведомления

```yaml
name: Задача закрыта — знания и чейнджлог
on:
  event: task.status_changed
  where: { to: done, task.type: [task, bug] }
limits: { concurrency: 2, max_runs_per_hour: 20 }
steps:
  - id: docs
    agent:
      role: documenter
      goal: Consolidate the task's artifacts into the project's vault space (update existing pages, link back to the task, refresh `verified`).
      inputs: { task: "{{ event.task.id }}" }
      workspace: read-only            # для проекта без кода — none
      output: { schema: { pages_changed: string[], summary: string, changelog: { section: string, text: string } } }
  - id: publish
    vault.propose:
      from: docs                      # правки задания; политика раздела решает: коммит или ревью
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
        review: "{{ steps.publish.output.proposal_url }}"
```

Что видит команда: в карточке задачи — артефакт «Знания обновлены» со списком страниц и, если раздел требует ревью, ссылкой на предложение; в `changelog.md` проекта — строка в `Unreleased` со ссылкой на задачу; у владельцев — одно сообщение в Telegram или почте с итогом и кнопкой «Открыть».

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

Как это выглядит для менеджера: через несколько минут после создания задачи в Telegram приходит «G-42 · 3 вопроса от аналитиков» — по сообщению на вопрос, с кнопками вариантов, если они есть. Ответ кнопкой или текстом сразу записывается в задачу комментарием `owner`. Когда отвечены все вопросы, оркестратор завершает уточнение.

## Библиотека плейбуков (первая версия)

| Плейбук | Триггер | Что делает |
|---|---|---|
| Разбор новой задачи | `task.created` во входящих | пример 2 |
| Знания и чейнджлог | `task.status_changed → done` | пример 1 |
| Эскалация решения | `needs_owner` дольше N часов | напоминание адресату, затем владельцу проекта |
| Устаревшие знания | расписание, раз в неделю | задачи на актуализацию страниц vault с меткой «возможно устарела» |
| Ревью знаний ждёт | предложение в vault дольше N часов | напоминание владельцу раздела |
| Утренний дайджест | расписание, будни 9:00 | каждому участнику: что ждёт его, что закрыто, что застряло |
| Релиз | ручной запуск | `Unreleased` → версия, заметки о выпуске в каналы |
| Эпик закрыт | `epic.progress` = 100% | документатор пишет обзор эпика, уведомление заинтересованным |
| CI упал на ветке команды | `ci.failed` (после Ф6) | срочное письмо исполнителю команды с логом |
| PR смёрджен | `git.pr_merged` (после Ф6) | задача → `done` (если `approved`), остановка команды |

## Надёжность и безопасность

- **Ровно один запуск на событие**: ключ идемпотентности `(automation_id, version, event_id)`; повторная доставка события второй запуск не создаёт.
- **Долговечность**: запуски и шаги хранятся в БД; после рестарта сервер продолжает шаги в статусах `pending` и `waiting`. Агентные задания переподключаются тем же механизмом, что `team_recover`.
- **Каскады**: событие несёт `cause` — цепочку запусков. При глубине больше 3 или повторе того же правила в цепочке запуск не создаётся, в журнале остаётся пометка. Действия правила по умолчанию не запускают это же правило.
- **Лимиты**: параллельность и число запусков в час на правило, параллельность агентных заданий на проект; таймаут на шаг и на задание; кнопка «остановить все запуски правила». Деньги ограничивает провайдер; genie передаёт ему метки (проект, задача, правило), если провайдер их принимает.
- **Права**: правило исполняется от актора `automation:<id>` с правами не выше, чем у его автора; менять автоматизации могут owner и admin.
- **Недоверенный ввод**: текст из каналов и webhooks передаётся агентам как данные с пометкой источника; шаги, которые меняют права, секреты или удаляют данные, в правилах с внешним триггером запрещены.
- **Наблюдаемость**: экран «Запуски» — лента с фильтрами (правило, задача, статус), граф шагов с входами и выходами, кнопки «повторить шаг», «остановить», «открыть задачу». `dry-run` показывает, что сделало бы правило на прошлых событиях.

## Модель данных (набросок)

```
automations(id, project, name, version, enabled, dry_run, spec JSON, created_by, created, updated)
automation_runs(id, automation, version, event_id, status, cause JSON, started, finished, error)
run_steps(id, run, step_id, status, attempt, input JSON, output JSON, started, finished, error)
agent_jobs(id, run_step, project, task, role, model, workspace, runtime JSON, session_file, status, output JSON, usage JSON)
questionnaires(id, project, task, asked_by, recipient_user, channel, status, due, created)
questions(id, questionnaire, n, text, why, options JSON, answer, answered_by, answered_at, channel_message_ref)
subscriber_cursors(subscriber, last_event_id)
```

Статусы запуска: `queued → running → waiting → succeeded | failed | cancelled | skipped` (`skipped` — dry-run или сработал лимит). `usage` — токены задания для информации, без бюджетов.
