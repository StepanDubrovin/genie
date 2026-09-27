export function StageBars({ stage, amber, big }: { stage: number; amber?: boolean; big?: boolean }) {
  return (
    <span className={`bars${amber ? " amber" : ""}${big ? " big" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={6} aria-valuenow={stage}>
      {Array.from({ length: 6 }, (_, i) => (
        <span key={i} className={i < stage ? "on" : ""} />
      ))}
    </span>
  );
}
