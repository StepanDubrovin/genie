import { useState } from "react";
import { isRasterFileName } from "@/shared/lib";
import { Icon, ImagePreview } from "@/shared/ui";

/**
 * Artifact list thumbnail: a loaded preview for a raster artifact, or the plain
 * file icon for anything else — including a mislabeled file whose bytes are not
 * a supported image. Reused by the task card and the epic shared-artifact list.
 */
export function ArtifactThumb({ task, artifact }: { task: string; artifact: { id: number; name: string } }) {
  const [failed, setFailed] = useState(false);
  if (failed || !isRasterFileName(artifact.name)) return <Icon.file />;
  return (
    <ImagePreview
      src={`/api/tasks/${encodeURIComponent(task)}/artifacts/${artifact.id}?raw=1`}
      variant="thumb"
      interactive={false}
      alt={artifact.name}
      onUnavailable={() => setFailed(true)}
    />
  );
}
