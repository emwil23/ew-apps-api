/**
 * Fixed-window counter per IP, kept in memory.
 * shortcut: one Heroku dyno means one process, so memory is enough; move to Redis/Postgres if we ever scale out.
 */
export function createIpLimiter(limit: number, windowMs: number, now = Date.now) {
  const hits = new Map<string, { count: number; resetAt: number }>()

  return (ip: string): boolean => {
    const t = now()
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k)
    const entry = hits.get(ip)
    if (!entry || entry.resetAt <= t) {
      hits.set(ip, { count: 1, resetAt: t + windowMs })
      return true
    }
    entry.count++
    return entry.count <= limit
  }
}
