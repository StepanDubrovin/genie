export function Labels({ labels }: { labels: string[] }) {
  if (!labels.length) return null;
  return (
    <span className="labels">
      {labels.map((l) => (
        <span key={l} className="pill">
          {l}
        </span>
      ))}
    </span>
  );
}
