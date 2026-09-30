// A task's delivery: the repositories it works in, its branches and pull/merge requests,
// the checks, and — for people — the merge.

import { useState } from "react";
import { CI_NAME, CR_NAME, type TaskRepo, useMergeRequest, useTaskRepos } from "@/entities/repo";
import { ConfirmDialog, useToast } from "@/shared/ui";

function ciLevel(ci: TaskRepo["ciState"]): "ok" | "warn" | "fail" | "" {
  return ci === "passed" ? "ok" : ci === "failed" ? "fail" : ci === "pending" ? "warn" : "";
}

export function TaskDelivery({ task }: { task: string }) {
  const rows = useTaskRepos(task).data?.repos ?? [];
  const merge = useMergeRequest();
  const toast = useToast();
  const [merging, setMerging] = useState<TaskRepo>();
  if (!rows.length) return null;
  return (
    <section className="sec">
      <h3>
        Репозитории <span className="n">{rows.length}</span>
      </h3>
      <div className="td-delivery">
        {rows.map((r) => (
          <div key={r.repo} className="td-repo">
            <b>{r.repo}</b>
            <span className="pill">{r.access === "write" ? "запись" : "чтение"}</span>
            {r.branch && <span className="mono">{r.branch}</span>}
            {r.crNumber ? (
              <>
                {r.crUrl ? (
                  <a href={r.crUrl} target="_blank" rel="noreferrer">
                    запрос #{r.crNumber}
                  </a>
                ) : (
                  <span>запрос #{r.crNumber}</span>
                )}
                <span className={`pill ${r.crState === "merged" ? "ok" : r.crState === "closed" ? "warn" : ""}`}>{CR_NAME[r.crState ?? "open"]}</span>
                {r.crState === "open" && <span className={`pill ${ciLevel(r.ciState)}`}>{CI_NAME[r.ciState ?? "none"]}</span>}
                {r.crState === "open" && (
                  <button type="button" className="btn ghost" style={{ height: 24 }} onClick={() => setMerging(r)}>
                    Слить
                  </button>
                )}
              </>
            ) : r.state === "published" ? (
              <span className="muted">ветка отправлена, запроса ещё нет</span>
            ) : r.access === "write" ? (
              <span className="muted">пока без изменений на хостинге</span>
            ) : null}
          </div>
        ))}
      </div>
      {merging && (
        <ConfirmDialog
          title={`Слить запрос #${merging.crNumber}?`}
          confirmLabel="Слить"
          busy={merge.isPending}
          onClose={() => setMerging(undefined)}
          onConfirm={() =>
            merge.mutate(
              { task, repo: merging.repo },
              {
                onSuccess: () => {
                  toast("Запрос слит");
                  setMerging(undefined);
                },
                onError: (e) => toast(e.message, "error"),
              },
            )
          }
        >
          Запрос слит на хостинге от имени бота genie. Как человек вы не связаны условиями «нужны проверки и одобрения» — но правила защиты веток на хостинге по-прежнему действуют.
        </ConfirmDialog>
      )}
    </section>
  );
}
