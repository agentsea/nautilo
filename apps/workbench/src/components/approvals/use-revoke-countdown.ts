import { useCallback, useEffect, useRef, useState } from "react";

type Timers = {
  interval?: ReturnType<typeof setInterval>;
  timeout?: ReturnType<typeof setTimeout>;
};

/**
 * Client-side undo window before a standing approval DELETE commits.
 * Timers are cleared on unmount so closing the pane mid-countdown leaves
 * the rule intact on the server.
 */
export function useRevokeCountdown(options: {
  durationMs: number;
  onExpire: () => void;
}) {
  const { durationMs, onExpire } = options;
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  const timersRef = useRef<Timers>({});
  const [active, setActive] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);

  const clearTimers = useCallback(() => {
    const t = timersRef.current;
    if (t.interval !== undefined) clearInterval(t.interval);
    if (t.timeout !== undefined) clearTimeout(t.timeout);
    timersRef.current = {};
  }, []);

  const cancel = useCallback(() => {
    clearTimers();
    setActive(false);
    setSecondsLeft(0);
  }, [clearTimers]);

  const start = useCallback(() => {
    clearTimers();
    const totalSeconds = Math.max(1, Math.ceil(durationMs / 1000));
    const deadline = Date.now() + durationMs;
    setSecondsLeft(totalSeconds);
    setActive(true);

    timersRef.current.interval = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setSecondsLeft(remaining);
    }, 200);

    timersRef.current.timeout = setTimeout(() => {
      clearTimers();
      setActive(false);
      setSecondsLeft(0);
      onExpireRef.current();
    }, durationMs);
  }, [clearTimers, durationMs]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  return { active, secondsLeft, start, cancel };
}
