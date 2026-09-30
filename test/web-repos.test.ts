// Repositories in the web: reading the link people paste into «Новый репозиторий».

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRepoLink, repoNameFrom } from "../web/src/entities/repo/model.ts";

const hosts = [
  { id: "sdvor", kind: "gitlab", url: "https://git.sdvor.ru" },
  { id: "github", kind: "github", url: "https://github.com" },
  { id: "corp", kind: "gitlab", url: "https://corp.example/gitlab/" },
];

test("a repository link is read the way people copy it", () => {
  const ok = (host: string, remote: string) => ({ kind: "ok", host, remote });
  assert.deepEqual(parseRepoLink("https://git.sdvor.ru/sklad/sd-chrono", hosts), ok("sdvor", "sklad/sd-chrono"), "the page in a browser");
  assert.deepEqual(parseRepoLink(" https://git.sdvor.ru/sklad/sub/sd-chrono/-/tree/main?ref=x ", hosts), ok("sdvor", "sklad/sub/sd-chrono"), "a page inside the repository");
  assert.deepEqual(parseRepoLink("https://git.sdvor.ru/sklad/sd-chrono.git", hosts), ok("sdvor", "sklad/sd-chrono"), "the https clone address");
  assert.deepEqual(parseRepoLink("git@git.sdvor.ru:sklad/sd-chrono.git", hosts), ok("sdvor", "sklad/sd-chrono"), "the ssh clone address");
  assert.deepEqual(parseRepoLink("ssh://git@git.sdvor.ru:2222/sklad/sd-chrono.git", hosts), ok("sdvor", "sklad/sd-chrono"), "ssh with a port");
  assert.deepEqual(parseRepoLink("https://github.com/acme/api/pull/3", hosts), ok("github", "acme/api"), "on GitHub a repository is owner/name");
  assert.deepEqual(parseRepoLink("https://corp.example/gitlab/team/app", hosts), ok("corp", "team/app"), "a host under a path");
});

test("what the link cannot say is said back", () => {
  assert.deepEqual(parseRepoLink("", hosts), { kind: "empty" });
  assert.deepEqual(parseRepoLink("https://gitea.example/a/b", hosts), { kind: "unknown", hostname: "gitea.example" });
  assert.deepEqual(parseRepoLink("sklad/sd-chrono", hosts), { kind: "path", remote: "sklad/sd-chrono" }, "a bare path: the host is asked");
  assert.deepEqual(parseRepoLink("https://git.sdvor.ru/sklad", hosts), { kind: "bad" }, "a group is not a repository");
  assert.deepEqual(parseRepoLink("a/../b", hosts), { kind: "bad" });
});

test("the name in the project comes from the repository's last part", () => {
  assert.equal(repoNameFrom("sklad/sd-chrono"), "sd-chrono");
  assert.equal(repoNameFrom("a/SD.Chrono_api"), "sd-chrono_api");
});
