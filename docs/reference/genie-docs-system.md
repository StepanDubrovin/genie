# Genie project documentation contract

**Schema frozen:** the docs index schema is frozen at `DOCS_SCHEMA_VERSION = 1` and its DDL is unchanged since G-8; frontmatter-contract changes follow their own path.

Genie indexes Markdown files below the configured project docs root (`docs.root`, default `docs`). Markdown files remain the source of truth; the SQLite index is a rebuildable cache. The current index schema is intentionally independent of task tracking.

## Frontmatter

A page may begin with a YAML-like block delimited by `---`. Genie supports only the fields and value forms below; this is a deliberately narrow contract, not a general YAML implementation.

```yaml
---
title: Authentication flow
type: guide
status: current
summary: How browser sessions are issued and renewed.
tags: [auth, sessions]
aliases: [login, sign-in, вход]
paths: [src/auth/**, src/session.ts]
related: [G-42, G-4]
verified: 2026-09-27
---
```

| Field | Type | Meaning |
|---|---|---|
| `title` | non-empty, single-line string | Display title. If omitted or invalid, Genie uses the first H1, then the filename. |
| `type` | `guide`, `reference`, `decision`, `glossary`, `runbook`, or `note` | Page kind. |
| `status` | `draft`, `current`, or `deprecated` | Editorial state. Missing is unknown, not implicitly current. Deprecated pages are excluded from search unless explicitly requested (see Search and reads). |
| `summary` | optional, single-line string | L0/index summary. If omitted or invalid, Genie uses the first body paragraph. |
| `tags` | optional list of strings | Searchable terms. |
| `aliases` | optional list of strings | Alternate searchable names, including translations and synonyms. |
| `paths` | optional list of repo-relative POSIX globs | Code areas described by the page. Supported syntax: `*` within one path segment, `**` across segments, `?` for one non-slash character; other characters are literal. |
| `related` | optional list of task/epic IDs | Explicit Genie task or epic relationships, such as `G-42`. |
| `verified` | optional `YYYY-MM-DD` date | Date a human or agent last reviewed the page against its described code. |

Lists can use inline brackets as above or indented `- item` lines. Values can be plain, single-quoted, or double-quoted strings. Do not use nested objects, multiline scalars, YAML aliases, or implicit timestamps. Invalid fields and malformed frontmatter produce page diagnostics; the Markdown body remains indexed and searchable. Diagnostics are available on page/search results and through the docs service diagnostics list.

`paths` and `verified` are independent. If either is missing, staleness is unknown rather than automatically fresh or stale. A matching code change after `verified` produces only a possible-stale warning; it never hides or invalidates a page. `updated` is derived from the file's Git last-commit date, is cached by the index, and is not a frontmatter field.

## Markdown links

Use `[[architecture/auth]]` for a Genie wiki-link. A target may include a heading (`[[architecture/auth#Session lifecycle]]`) or display text (`[[architecture/auth|authentication]]`). A canonical docs-relative path is preferred. A unique basename or alias may resolve; unresolved and ambiguous targets are reported and are never guessed. Resolved links provide backlinks.

## Search and reads

Search indexes title, summary, headings, body, tags, and aliases using SQLite FTS5. English diacritics are normalized by the tokenizer, and Russian `ё`/`е` are treated symmetrically. Heading reads return that heading's subtree and mark truncated content explicitly.

Pages with `status: deprecated` are excluded from search results by default. They are returned only when explicitly requested: an explicit `status` filter (`genie docs search --status deprecated`), a page whose `related` list contains a requested task/epic id, or the service's `includeDeprecated: true` opt-in. The exclusion is applied before the result limit, so a default search never drops a non-deprecated match to make room for a deprecated one. Tree entries and page reads still list deprecated pages with their `deprecated` marker; backlinks are plain source paths with no marker.

The index is scoped to the canonical project checkout, including linked worktrees. Configure `docs.root` as a non-empty relative path inside the project; traversal and symlink escapes are rejected. Rebuild recreates only the docs cache tables, leaving Genie task data untouched.
