import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildL0Inventory,
  buildL1Context,
  DocsContext,
  docsStatSignature,
  formatReadResult,
  formatSearchResults,
  L0_HARD_CAP_UNITS,
  L0_TARGET_UNITS,
  L1_MAX_PAGES,
  L1_PAGE_UNITS,
  L1_TOTAL_UNITS,
  normalizeTerm,
  publishExclusive,
  selectL1Pages,
  slugify,
  units,
  writeDocNote,
  type L1Task,
} from "../src/docs/context.ts";
import { DocsService } from "../src/docs/service.ts";
import { callText } from "../src/extension/render.ts";
import { Db } from "../src/tracker/db.ts";
import { Tracker } from "../src/tracker/store.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "genie-docs-context-test-"));
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initGit(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.email", "docs-context@example.com");
  git(root, "config", "user.name", "Docs Context Test");
}

function commit(root: string, message: string): void {
  git(root, "add", "-A");
  git(root, "-c", "user.email=docs-context@example.com", "-c", "user.name=Docs Context Test", "commit", "-q", "-m", message, "--allow-empty");
}

function write(root: string, relative: string, text: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function createTracker(root: string): Tracker {
  return Tracker.init(path.join(root, ".genie"));
}

function service(root: string, tracker: Tracker, docsRoot = "docs"): DocsService {
  return new DocsService({ db: tracker.db, cwd: root, trackerDir: tracker.dir, docsRoot });
}

const fm = (body: string, metadata = "") => `---\n${metadata}---\n${body}`;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Locate a Bun runtime: `bun` on PATH, `GENIE_BUN_BIN`, or a pi-embedded Bun (BUN_BE_BUN=1). */
function bunRuntime(): { command: string; args: string[]; env?: Record<string, string> } | undefined {
  const override = process.env.GENIE_BUN_BIN;
  if (override && fs.existsSync(override)) return { command: override, args: ["run"] };
  const direct = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (!direct.error && direct.status === 0) return { command: "bun", args: ["run"] };
  const installs = path.join(os.homedir(), ".local", "share", "mise", "installs", "pi");
  if (fs.existsSync(installs)) {
    for (const version of fs.readdirSync(installs).sort().reverse()) {
      const binary = path.join(installs, version, "pi", "pi");
      if (fs.existsSync(binary)) return { command: binary, args: ["run"], env: { BUN_BE_BUN: "1" } };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- 1. estimator

test("estimator units use chars/4 Latin and chars/2 Cyrillic, rounded up", () => {
  assert.equal(units(""), 0);
  assert.equal(units("abcd"), 1);
  assert.equal(units("abcde"), 2);
  assert.equal(units("абвг"), 2);
  assert.equal(units("abаб"), 2); // ceil(2/4 + 2/2)
  assert.equal(units("   "), 1); // whitespace counts as Latin
  assert.equal(units("ёж"), 1); // U+0451 is in the Cyrillic block
  assert.equal(units("Ҁҁ"), 1); // U+0500–052F supplement is Cyrillic too
  assert.ok(units("русский текст".repeat(10)) > units("latin text".repeat(10)));
});

// ---------------------------------------------------------------- 2. L0 basics

test("L0 inventory is metadata-only and carries stale, draft, unverified, deprecated and diagnostic markers", () => {
  const root = tmp();
  initGit(root);
  write(root, "docs/alpha.md", fm("# Alpha\n\nAnchor text.", "title: Alpha\ntype: guide\nstatus: current\nsummary: Alpha summary\npaths: [src/alpha/**]\nverified: 2020-01-01\n"));
  write(root, "docs/draft.md", fm("# Draft page\n\nDraft body.", "title: Draft page\nstatus: draft\n"));
  write(root, "docs/unverified.md", "# Unverified page\n\nNo metadata at all.");
  write(root, "docs/deprecated.md", fm("# Old page\n\nLegacy.", "title: Old page\nstatus: deprecated\n"));
  write(root, "docs/broken.md", fm("# Broken page\n\nA short first paragraph.\n\nBody-only-secret-phrase.", "title: [not valid\n"));
  write(root, "src/alpha/code.ts", "export const changed = true;\n");
  commit(root, "initial docs");
  write(root, "src/alpha/code.ts", "export const changed = false;\n");
  commit(root, "touch alpha code");
  const tracker = createTracker(root);
  const inventory = buildL0Inventory(service(root, tracker));

  assert.equal(inventory.pages, 5);
  assert.equal(inventory.compacted, false);
  assert.ok(inventory.units <= L0_TARGET_UNITS);
  assert.doesNotMatch(inventory.text, /Body-only-secret-phrase/, "L0 must never include page bodies");
  assert.match(inventory.text, /Alpha summary/);
  assert.match(inventory.text, /\[stale\]/);
  assert.match(inventory.text, /\[draft\]/);
  assert.match(inventory.text, /\[unverified\]/);
  assert.match(inventory.text, /\[deprecated\]/);
  assert.match(inventory.text, /\[check frontmatter\]/);
  const order = [...inventory.text.matchAll(/^- (.+?) \(/gm)].map((match) => match[1]);
  assert.deepEqual(order, ["Alpha", "Broken page", "Old page", "Draft page", "Unverified page"], "path order stays deterministic");
  tracker.db.close();
});

// ---------------------------------------------------------------- 3. over-cap L0 fixture

test("over-cap L0 fixture compacts, stays under the hard cap and marks what is omitted", () => {
  const root = tmp();
  const tracker = createTracker(root);
  for (let index = 0; index < 30; index++) {
    write(
      root,
      `docs/ru-${String(index).padStart(2, "0")}.md`,
      fm(`# Документ ${index}\n\nТело документа.`, `title: Документ номер ${index}\ntype: guide\nstatus: current\nsummary: Описание страницы номер ${index} для проверки компактизации индекса документации\n`),
    );
  }
  const inventory = buildL0Inventory(service(root, tracker));
  assert.equal(inventory.pages, 30);
  assert.equal(inventory.compacted, true);
  assert.ok(inventory.units <= L0_TARGET_UNITS, `compacted L0 must fit the target (got ${inventory.units})`);
  assert.ok(inventory.units <= L0_HARD_CAP_UNITS);
  assert.ok(inventory.shown < inventory.pages);
  assert.equal(inventory.omitted, inventory.pages - inventory.shown);
  assert.match(inventory.text, /compact: showing \d+ of 30/);
  assert.match(inventory.text, /more page\(s\) not listed/);
  assert.match(inventory.text, /draft 0, stale 0/);
  tracker.db.close();
});

// ---------------------------------------------------------------- 4. L0 cache

test("L0 cache reuses an unchanged signature, rebuilds after a change, and degrades to undefined on errors", () => {
  const root = tmp();
  const tracker = createTracker(root);
  write(root, "docs/one.md", fm("# One\n\nFirst text.", "title: One\nstatus: current\n"));
  const context = new DocsContext({ db: tracker.db, trackerDir: tracker.dir, docsRoot: "docs" });

  const first = context.l0(root);
  assert.ok(first);
  assert.match(first.text, /One/);
  assert.equal(context.l0(root), first, "unchanged docs signature returns the cached object");

  write(root, "docs/one.md", fm("# One renamed\n\nA longer different text.", "title: One renamed\nstatus: current\n"));
  const rebuilt = context.l0(root);
  assert.ok(rebuilt);
  assert.notEqual(rebuilt, first);
  assert.match(rebuilt.text, /One renamed/);

  const missing = tmp();
  const missingTracker = createTracker(missing);
  const missingContext = new DocsContext({ db: missingTracker.db, trackerDir: missingTracker.dir, docsRoot: "docs" });
  assert.equal(missingContext.l0(missing), undefined, "a missing docs root yields no section");

  const noFtsDb = new Proxy(tracker.db, {
    get(target, property) {
      if (property === "exec") {
        return (sql: string) => {
          if (sql.includes("CREATE VIRTUAL TABLE") && sql.includes("docs_pages_fts")) throw new Error("no such module: fts5");
          return target.exec(sql);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const broken = new DocsContext({ db: noFtsDb, trackerDir: tracker.dir, docsRoot: "docs" });
  assert.equal(broken.l0(root), undefined, "service errors must never break a prompt");
  missingTracker.db.close();
  tracker.db.close();
});

test("docsStatSignature is absent for a missing root and changes when a file changes", () => {
  const root = tmp();
  assert.equal(docsStatSignature(path.join(root, "docs")), "absent");
  write(root, "docs/a.md", "# A\n");
  const before = docsStatSignature(path.join(root, "docs"));
  write(root, "docs/a.md", "# A with a longer body\n");
  const after = docsStatSignature(path.join(root, "docs"));
  assert.notEqual(before, "absent");
  assert.notEqual(before, after);
});

// ---------------------------------------------------------------- 5. real repo measurement

test("real-repo L0 measurement stays under the target and reports units/chars/pages", () => {
  const db = new Db(":memory:");
  const inventory = buildL0Inventory(new DocsService({ db, cwd: REPO_ROOT }));
  console.log(`[G-9 measurement] L0 real repo: pages=${inventory.pages} chars=${inventory.text.length} units=${inventory.units} compacted=${inventory.compacted} target=${L0_TARGET_UNITS} hardCap=${L0_HARD_CAP_UNITS}`);
  assert.ok(inventory.pages >= 4);
  assert.ok(inventory.units <= L0_TARGET_UNITS, `real-repo L0 must fit the target (got ${inventory.units})`);
  db.close();
});

// ---------------------------------------------------------------- 6. L1 rank determinism

test("L1 selection ranks related > path > term deterministically and reports reasons", () => {
  const root = tmp();
  const tracker = createTracker(root);
  write(root, "docs/related.md", fm("# Related page\n\nRelated body.", "title: Related page\nrelated: [G-9]\nstatus: current\n"));
  write(root, "docs/path.md", fm("# Path page\n\nPath body.", "title: Path page\npaths: [src/extension/index.ts]\nstatus: current\n"));
  write(root, "docs/term.md", fm("# Widgets\n\nTerm body.", "title: Widgets\ntags: [widgetry]\nstatus: current\n"));
  const docs = service(root, tracker);
  const task: L1Task = {
    id: "G-9",
    title: "Widgets work",
    description: "Update src/extension/index.ts in the extension.",
    plan: "",
    acceptance: [],
  };
  const selected = selectL1Pages(docs, task);
  assert.deepEqual(selected.map((item) => item.page.path), ["related.md", "path.md", "term.md"]);
  assert.deepEqual(selected.map((item) => item.rank), [0, 1, 2]);
  assert.deepEqual(selected[0].reasons, ["related G-9"]);
  assert.deepEqual(selected[1].reasons, ["path match src/extension/index.ts"]);
  assert.deepEqual(selected[2].reasons, ["term match Widgets"]);

  const context = buildL1Context(docs, task);
  assert.ok(context);
  assert.match(context.text, /## Project docs \(L1 context\)/);
  assert.match(context.text, /### Related page \(untyped, current\) — related G-9/);
  assert.ok(context.totalUnits <= L1_TOTAL_UNITS);
  tracker.db.close();
});

test("L1 tie-breaks prefer current over draft and exclude deprecated unless related", () => {
  const root = tmp();
  const tracker = createTracker(root);
  write(root, "docs/s-current.md", fm("# Sessions\n\nCurrent.", "title: Sessions\nstatus: current\n"));
  write(root, "docs/s-draft.md", fm("# Sessions\n\nDraft.", "title: Sessions\nstatus: draft\n"));
  write(root, "docs/s-deprecated.md", fm("# Sessions\n\nOld.", "title: Sessions\nstatus: deprecated\n"));
  write(root, "docs/s-related-deprecated.md", fm("# Legacy related\n\nOld related.", "title: Legacy related\nstatus: deprecated\nrelated: [G-9]\n"));
  const docs = service(root, tracker);
  const selected = selectL1Pages(docs, { id: "G-9", title: "Sessions", description: "", plan: "", acceptance: [] });
  const paths = selected.map((item) => item.page.path);
  assert.ok(paths.includes("s-current.md"));
  assert.ok(paths.includes("s-draft.md"));
  assert.ok(paths.indexOf("s-current.md") < paths.indexOf("s-draft.md"), "current outranks draft on a tie");
  assert.ok(!paths.includes("s-deprecated.md"), "deprecated pages are excluded unless related");
  assert.ok(paths.includes("s-related-deprecated.md"), "a related deprecated page stays visible");
  tracker.db.close();
});

// ---------------------------------------------------------------- 7. Russian term-only fixture

test("Russian term-only fixture: ё/е folds, inflections do not (non-stemmed FTS5), aliases bridge", () => {
  const root = tmp();
  const tracker = createTracker(root);
  write(root, "docs/ru.md", fm("# Ёжик\n\nМаленький ёжик живёт в лесу.", "title: Ёжик\naliases: [ежик, сессия]\nstatus: current\n"));
  write(root, "docs/session.md", fm("# Sessions\n\nHow sessions work.", "title: Sessions\naliases: [сессия]\nstatus: current\n"));
  const docs = service(root, tracker);
  assert.equal(normalizeTerm("ЁЖИК"), "ежик");
  assert.equal(normalizeTerm("ежик"), "ежик");

  const selected = selectL1Pages(docs, { id: "G-9", title: "ёжик", description: "сессию", plan: "", acceptance: [] });
  assert.deepEqual(selected.map((item) => item.page.path), ["ru.md"], "only the exact (folded) alias matches");
  assert.deepEqual(selected[0].reasons, ["term match ёжик"]);

  assert.equal(docs.search("ежик")[0]?.path, "ru.md", "the FTS5 index still finds the page");
  tracker.db.close();
});

// ---------------------------------------------------------------- 8. over-clip L1 fixture

function bigPage(title: string, sections: number, metadata: string): string {
  const body: string[] = [`# ${title}`];
  for (let index = 0; index < sections; index++) {
    body.push("", `## Section ${index}`, "", "content ".repeat(400));
  }
  return fm(body.join("\n"), metadata);
}

test("over-clip L1 fixture clips at section boundaries with a marker and never exceeds the per-page cap", () => {
  const root = tmp();
  const tracker = createTracker(root);
  write(root, "docs/big.md", bigPage("Big page", 5, "title: Big page\nrelated: [G-9]\nstatus: current\n"));
  const docs = service(root, tracker);
  const context = buildL1Context(docs, { id: "G-9", title: "anything", description: "", plan: "", acceptance: [] });
  assert.ok(context);
  const page = context.pages[0];
  assert.equal(page.path, "big.md");
  assert.equal(page.clipped, true);
  assert.equal(page.sections, 6);
  assert.ok(page.shownSections < 6);
  assert.ok(page.units <= L1_PAGE_UNITS, `page units ${page.units} must stay under ${L1_PAGE_UNITS}`);
  assert.match(context.text, /clipped at section boundaries: showing \d+ of 6 sections/);
  assert.doesNotMatch(context.text, /## Section 4/, "sections past the clip are dropped");
  tracker.db.close();
});

test("L1 caps the block at three pages and the total at 4000 units, marking the clipped page", () => {
  const root = tmp();
  const tracker = createTracker(root);
  for (let index = 0; index < 4; index++) {
    write(root, `docs/cap-${index}.md`, bigPage(`Cap page ${index}`, 4, `title: Cap page ${index}\nrelated: [G-9]\nstatus: current\n`));
  }
  const docs = service(root, tracker);
  const context = buildL1Context(docs, { id: "G-9", title: "anything", description: "", plan: "", acceptance: [] });
  assert.ok(context);
  assert.equal(context.pages.length, L1_MAX_PAGES);
  assert.ok(context.totalUnits <= L1_TOTAL_UNITS, `total units ${context.totalUnits} must stay under ${L1_TOTAL_UNITS}`);
  assert.ok(context.pages.some((item) => item.clipped), "the last page is clipped by the remaining budget");
  tracker.db.close();
});

test("L1 marks stale and draft pages instead of hiding them", () => {
  const root = tmp();
  initGit(root);
  write(root, "src/area/code.ts", "export const value = 1;\n");
  write(root, "docs/stale.md", fm("# Stale page\n\nBody.", "title: Stale page\nrelated: [G-9]\npaths: [src/area/**]\nverified: 2020-01-01\n"));
  write(root, "docs/draft.md", fm("# Draft page\n\nBody.", "title: Draft page\nrelated: [G-9]\nstatus: draft\n"));
  commit(root, "initial");
  write(root, "src/area/code.ts", "export const value = 2;\n");
  commit(root, "change area");
  const tracker = createTracker(root);
  const context = buildL1Context(service(root, tracker), { id: "G-9", title: "anything", description: "", plan: "", acceptance: [] });
  assert.ok(context);
  assert.match(context.text, /### Stale page .*stale/);
  assert.match(context.text, /### Draft page .*draft/);
  tracker.db.close();
});

// ---------------------------------------------------------------- 9. docs_note

test("docs_note writes unique, atomic, non-overwriting notes and refreshes the index", () => {
  const root = tmp();
  const tracker = createTracker(root);
  const docs = service(root, tracker);
  const date = new Date().toISOString().slice(0, 10);
  const inbox = path.join(root, "docs", "inbox");
  fs.mkdirSync(inbox, { recursive: true });
  const sentinel = path.join(inbox, `${date}-first-note.md`);
  fs.writeFileSync(sentinel, "SENTINEL");

  const first = writeDocNote(docs, { title: "First note", body: "unique note body" });
  assert.equal(first.path, `inbox/${date}-first-note-2.md`, "an existing file is never overwritten");
  assert.equal(fs.readFileSync(sentinel, "utf8"), "SENTINEL");
  const written = fs.readFileSync(first.absolute, "utf8");
  assert.match(written, /^---\ntitle: "First note"\ntype: note\nstatus: draft\n---/);
  assert.match(written, /unique note body/);
  assert.equal(fs.readdirSync(inbox).filter((file) => file.includes(".tmp")).length, 0, "no temp file is left behind");
  assert.equal(docs.search("unique note")[0]?.path, first.path, "the note is searchable after the write");

  const second = writeDocNote(docs, { title: "First note", body: "another body", tags: ["auth"], related: ["G-9"] });
  assert.equal(second.path, `inbox/${date}-first-note-3.md`);
  const secondBody = fs.readFileSync(second.absolute, "utf8");
  assert.match(secondBody, /tags: \["auth"\]/);
  assert.match(secondBody, /related: \["G-9"\]/);

  const cyrillic = writeDocNote(docs, { title: "Заметка о сессии", body: "текст" });
  assert.equal(cyrillic.slug, "zametka-o-sessii");
  assert.match(cyrillic.path, new RegExp(`^inbox/${date}-zametka-o-sessii\\.md$`));
  tracker.db.close();
});

test("slugify transliterates Cyrillic and keeps a non-empty fallback", () => {
  assert.equal(slugify("Заметка о сессии"), "zametka-o-sessii");
  assert.equal(slugify("Hello, World!"), "hello-world");
  assert.equal(slugify("ёж"), "ezh");
  assert.equal(slugify("!!!"), "note");
});

// ---------------------------------------------------------------- 10. tool formatting

test("search and read formatting surface stale, draft, score, snippet, diagnostics and truncation", () => {
  const root = tmp();
  const tracker = createTracker(root);
  write(root, "docs/source.md", fm("# Source\n\nSee [[target]]. needle sentence here.", "title: Source\nstatus: draft\n"));
  write(root, "docs/target.md", fm("# Target\n\nAnchor text with needle.", "title: Target\nstatus: current\n"));
  write(root, "docs/broken.md", fm("# Broken\n\nneedle inside broken page.", "title: [bad\n"));
  const docs = service(root, tracker);
  const search = formatSearchResults(docs.search("needle"), "needle");
  assert.match(search, /docs\/source\.md — Source \(untyped, draft/);
  assert.match(search, /\[.*draft.*\]/);
  assert.match(search, /score -?\d+\.\d\d/);
  assert.match(search, /….*needle.*…/);
  assert.match(search, /! /);
  assert.match(search, /docs\/broken\.md/);

  const source = formatReadResult(docs.read("source.md", { wholePage: true }));
  assert.match(source, /docs\/source\.md — Source/);
  assert.match(source, /links: target → target\.md/);

  const targetSection = formatReadResult(docs.read("target.md", { heading: "Target", maxChars: 5 }));
  assert.match(targetSection, /heading: Target/);
  assert.match(targetSection, /\[Truncated\]/);

  write(root, "docs/linked.md", "# Linked\n\nbody");
  const linked = formatReadResult(docs.read("linked.md", { wholePage: true }));
  assert.match(linked, /docs\/linked\.md — Linked/);
  tracker.db.close();
});

test("L1 selected pages exposed to the caller are bounded and unit-priced", () => {
  const root = tmp();
  const tracker = createTracker(root);
  write(root, "docs/big.md", bigPage("Big page", 5, "title: Big page\nrelated: [G-9]\nstatus: current\n"));
  const context = buildL1Context(service(root, tracker), { id: "G-9", title: "anything", description: "", plan: "", acceptance: [] });
  assert.ok(context);
  assert.equal(context.pages.length, 1);
  assert.ok(context.pages[0].units <= L1_PAGE_UNITS);
  assert.ok(context.totalUnits <= L1_TOTAL_UNITS);
  tracker.db.close();
});

// ---------------------------------------------------------------- 13. kickoff + Bun smoke

test("kickoff appends L1 docs context through the shared builder and stays compatible without docs", async () => {
  const { kickoff } = await import("../src/team/ops.ts");
  const root = tmp();
  const tracker = createTracker(root);
  const task = tracker.create({ name: "owner", role: "human" }, { title: "Anything at all" });
  write(root, "docs/rel.md", fm("# Rel\n\nBody.", `title: Rel\nrelated: [${task.id}]\nstatus: current\n`));
  const member = { name: "bender", role: "executor" as const };
  const base = kickoff("G-2", task, root, undefined, [member], member);
  assert.doesNotMatch(base, /## Project docs \(L1 context\)/);
  const withDocs = kickoff("G-2", task, root, undefined, [member], member, undefined, false, undefined, {
    db: tracker.db,
    trackerDir: tracker.dir,
    docsRoot: "docs",
  });
  assert.match(withDocs, /\n\n## Project docs \(L1 context\)/);
  assert.match(withDocs, new RegExp(`related ${task.id}`));
  assert.match(withDocs, /### Rel \(untyped, current\) — related/);
  tracker.db.close();
});

function bunContextProbeSource(): string {
  const source = (relative: string) => path.join(REPO_ROOT, relative).split(path.sep).join("/");
  return `import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Db } from ${JSON.stringify(source("src/tracker/db.ts"))};
import { DocsService } from ${JSON.stringify(source("src/docs/service.ts"))};
import { buildL0Inventory, buildL1Context, units } from ${JSON.stringify(source("src/docs/context.ts"))};
const root = fs.mkdtempSync(path.join(os.tmpdir(), "genie-docs-context-bun-"));
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
fs.writeFileSync(path.join(root, "docs", "ru.md"), "---\\ntitle: Ёжик\\nrelated: [G-1]\\naliases: [ежик]\\n---\\n\\n# Раздел\\n\\nМаленький ёжик живёт в лесу.\\n");
const db = new Db(path.join(root, "cache.sqlite"));
const docs = new DocsService({ db, cwd: root });
const l0 = buildL0Inventory(docs);
const l1 = buildL1Context(docs, { id: "G-1", title: "ёжик", description: "", plan: "", acceptance: [] });
console.log("BUN_CONTEXT " + JSON.stringify({ pages: l0.pages, l0Units: l0.units, l1: l1 ? l1.pages.length : 0, reason: l1?.pages[0]?.reasons[0] ?? "none", cyr: units("аб") }));
db.close();
`;
}

const bun = bunRuntime();
test("Bun (pi-embedded) smoke: context.ts builds L0/L1 and the estimator on bun:sqlite", { skip: bun ? false : "no Bun runtime available" }, () => {
  const dir = tmp();
  const probe = path.join(dir, "bun-context-probe.ts");
  fs.writeFileSync(probe, bunContextProbeSource());
  const result = spawnSync(bun!.command, [...bun!.args, probe], { encoding: "utf8", env: { ...process.env, ...bun!.env }, timeout: 120_000 });
  assert.equal(result.status, 0, `Bun context probe failed:\n${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split(/\r?\n/).find((item) => item.startsWith("BUN_CONTEXT"));
  assert.ok(line, `Bun context probe produced no result:\n${result.stdout}\n${result.stderr}`);
  const payload = JSON.parse(line.slice("BUN_CONTEXT ".length)) as { pages: number; l0Units: number; l1: number; reason: string; cyr: number };
  assert.equal(payload.pages, 1);
  assert.ok(payload.l0Units > 0 && payload.l0Units <= L0_TARGET_UNITS);
  assert.equal(payload.l1, 1);
  assert.equal(payload.reason, "related G-1");
  assert.equal(payload.cyr, 1);
});

function noteWriterSource(): string {
  const source = (relative: string) => path.join(REPO_ROOT, relative).split(path.sep).join("/");
  return `import { Db } from ${JSON.stringify(source("src/tracker/db.ts"))};
import { DocsService } from ${JSON.stringify(source("src/docs/service.ts"))};
import { writeDocNote } from ${JSON.stringify(source("src/docs/context.ts"))};
const root = process.argv[1];
const writer = process.argv[2];
const db = new Db(":memory:");
const docs = new DocsService({ db, cwd: root });
for (let i = 0; i < 5; i++) writeDocNote(docs, { title: "Race note", body: "writer " + writer + " number " + i });
db.close();
`;
}

test("exclusive note publishing never replaces an existing file", () => {
  const dir = tmp();
  const target = path.join(dir, "note.md");
  fs.writeFileSync(target, "ORIGINAL");
  const temp = path.join(dir, ".temp");
  fs.writeFileSync(temp, "REPLACEMENT");
  assert.equal(publishExclusive(temp, target), "exists", "a taken target is reported, not overwritten");
  assert.equal(fs.readFileSync(target, "utf8"), "ORIGINAL");
  fs.unlinkSync(temp);
  const fresh = path.join(dir, "fresh.md");
  fs.writeFileSync(temp, "FRESH");
  assert.equal(publishExclusive(temp, fresh), "created");
  assert.equal(fs.readFileSync(fresh, "utf8"), "FRESH");
});

test("docs_note survives concurrent writers and never overwrites another note", async () => {
  const root = tmp();
  const { spawn } = await import("node:child_process");
  const script = noteWriterSource();
  await Promise.all(
    [1, 2, 3, 4].map(
      (writer) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, ["--input-type=module", "-e", script, root, String(writer)], { stdio: "inherit" });
          child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`note writer ${writer} exited ${code}`))));
        }),
    ),
  );
  const date = new Date().toISOString().slice(0, 10);
  const inbox = path.join(root, "docs", "inbox");
  const files = fs.readdirSync(inbox).filter((file) => file.startsWith(`${date}-race-note`) && file.endsWith(".md"));
  assert.equal(files.length, 20, "every writer's note is kept under a unique name");
  const bodies = new Set<string>();
  for (const file of files) {
    const content = fs.readFileSync(path.join(inbox, file), "utf8");
    const body = content.split("---").slice(2).join("---").trim();
    assert.ok(body, `note ${file} has a body`);
    bodies.add(body);
  }
  assert.equal(bodies.size, 20, "no writer's body was clobbered");
  assert.equal(fs.readdirSync(inbox).filter((file) => file.includes(".tmp")).length, 0, "no temp file is left behind");
});

test("docs tool call rows summarize their arguments", () => {
  assert.equal(callText("docs_search", { query: "auth", type: "guide", limit: 5 }), 'docs_search "auth" guide · limit 5');
  assert.equal(callText("docs_search", { query: "сессии", status: "current" }), 'docs_search "сессии" current');
  assert.equal(callText("docs_search", { query: "auth" }), 'docs_search "auth"');
  assert.equal(callText("docs_read", { path: "auth.md", heading: "Sessions" }), "docs_read auth.md → Sessions");
  assert.equal(callText("docs_read", { path: "auth.md", wholePage: true }), "docs_read auth.md → whole page");
  assert.equal(callText("docs_read", { path: "auth.md" }), "docs_read auth.md");
  assert.equal(callText("docs_note", { title: "Session idea", tags: ["auth", "x"] }), 'docs_note "Session idea" tags×2');
  assert.equal(callText("docs_note", { title: "Session idea" }), 'docs_note "Session idea"');
});
