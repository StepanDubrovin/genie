import { useEffect, useState } from "react";
import { queryClient } from "./client.ts";

/** Server-sent change events → refetch everything that is on screen. */
export function useLiveUpdates(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const es = new EventSource("/api/events");
    let timer: ReturnType<typeof setTimeout> | undefined;
    es.addEventListener("change", () => {
      clearTimeout(timer);
      timer = setTimeout(() => void queryClient.invalidateQueries(), 150);
    });
    es.onopen = () => setOnline(true);
    es.onerror = () => setOnline(false);
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, []);
  return online;
}
