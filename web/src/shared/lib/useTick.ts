import { useEffect, useState } from "react";

/** Re-render every `ms` so relative times stay fresh. */
export function useTick(ms = 30_000): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
  return n;
}
