export function createClock(initial) {
  let current = initial;
  return {
    now: () => current,
    advanceTo(value) {
      if (!Number.isFinite(value) || value < current) throw new Error("Clock cannot move backwards");
      current = value;
    },
    isExpired: (expiresAt) => !Number.isFinite(expiresAt) || expiresAt <= current,
  };
}
export function timestamp(clock) {
  return new Date(clock.now()).toISOString();
}
