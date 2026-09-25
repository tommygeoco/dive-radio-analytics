// A broadcast may be linked by several posts from one account. Its persisted
// high-water reading contributes once, at the best observed value. Every
// distinct broadcast must have a reading before an account is complete.
export function accountPlaysHighWater(targets, account) {
  const broadcasts = new Map();
  for (const target of targets || []) {
    if (target?.kind !== "x" || target.account !== account || target.role === "promo"
      || target.playsStatus === "none" || !target.broadcastId) continue;
    const prior = broadcasts.get(target.broadcastId);
    const reading = target.playsHighWater;
    if (!Number.isSafeInteger(reading?.value) || reading.value < 0
      || typeof reading.asOf !== "string" || !Number.isFinite(Date.parse(reading.asOf))) {
      if (!prior) broadcasts.set(target.broadcastId, null);
      continue;
    }
    if (!prior || reading.value > prior.value || (reading.value === prior.value && reading.asOf > prior.asOf)) {
      broadcasts.set(target.broadcastId, { value: reading.value, asOf: reading.asOf });
    }
  }
  if (!broadcasts.size || [...broadcasts.values()].some((reading) => reading == null)) return null;
  return {
    value: [...broadcasts.values()].reduce((sum, reading) => sum + reading.value, 0),
    asOf: [...broadcasts.values()].map((reading) => reading.asOf).sort()[0],
  };
}
