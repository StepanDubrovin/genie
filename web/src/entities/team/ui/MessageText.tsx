import { Fragment, useState } from "react";
import { imageRefSrc, parseImageRefs, type ImageRef } from "@/shared/lib";
import { ImagePreview } from "@/shared/ui";

/**
 * Chat message body: local `!image[...]` references render as inline previews,
 * everything else (including unresolvable references) stays literal text. The
 * shared Markdown renderer is deliberately not involved here.
 */
export function MessageText({ text }: { text: string }) {
  const segments = parseImageRefs(text);
  if (segments.every((segment) => segment.type === "text")) return <>{text}</>;
  return (
    <>
      {segments.map((segment, i) =>
        segment.type === "text" ? <Fragment key={i}>{segment.text}</Fragment> : <ChatImage key={i} imageRef={segment.ref} raw={segment.raw} />,
      )}
    </>
  );
}

/** One reference: preview on success, the original token on any failure. */
function ChatImage({ imageRef, raw }: { imageRef: ImageRef; raw: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <>{raw}</>;
  return (
    <ImagePreview
      src={imageRefSrc(imageRef)}
      variant="inline"
      alt={raw}
      caption={imageRef.kind === "path" ? imageRef.path : raw}
      onUnavailable={() => setFailed(true)}
    />
  );
}
