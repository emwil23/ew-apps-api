import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'
import { streamText } from 'hono/streaming'
import { apps } from './apps/index.js'

export interface User {
  id: string
  /** The user confirmed they are 18 or older (Supabase `user_metadata.adult`). */
  adult: boolean
}

export interface Deps {
  allowedOrigins: string[]
  verifyToken: (token: string) => Promise<User | null>
  /** Counts one call and says if the user is still within today's quota. */
  useQuota: (userId: string, app: string) => Promise<{ allowed: boolean; remaining: number }>
  countryOf: (ip: string) => string | undefined
  /** Counts one call for this IP and says if it is still within the limit. */
  hitIpLimit: (ip: string) => boolean
  generate: (req: {
    system: string
    prompt: string
    maxOutputTokens: number
    signal: AbortSignal
  }) => AsyncIterable<string>
}

// The Gemini free tier may not be used to serve people in the EEA, the UK or Switzerland.
// prettier-ignore
export const BLOCKED_COUNTRIES = new Set([
  'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT',
  'NL','PL','PT','RO','SK','SI','ES','SE','IS','LI','NO','GB','CH',
])

// Heroku's router closes a request that sends nothing for 30s, so we stop the model well before.
const AI_TIMEOUT_MS = 25_000

/** Heroku appends the real client address as the last X-Forwarded-For entry; earlier ones can be forged. */
const clientIp = (header: string | undefined) => header?.split(',').at(-1)?.trim() ?? 'unknown'

export function createApp(deps: Deps) {
  const app = new Hono()

  app.use(secureHeaders())
  app.use(
    '/api/*',
    cors({
      origin: deps.allowedOrigins,
      allowHeaders: ['Authorization', 'Content-Type'],
      exposeHeaders: ['X-AI-Format', 'X-AI-Remaining'],
    }),
  )

  app.get('/health', (c) => c.json({ ok: true }))

  app.post('/api/ai/:app/:action', bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    const action = apps[c.req.param('app')]?.[c.req.param('action')]
    if (!action) return c.json({ error: 'unknown_action' }, 404)

    const ip = clientIp(c.req.header('x-forwarded-for'))
    const country = deps.countryOf(ip)
    if (country && BLOCKED_COUNTRIES.has(country))
      return c.json({ error: 'region_unavailable' }, 451)
    if (!deps.hitIpLimit(ip)) return c.json({ error: 'rate_limited' }, 429)

    const token = c.req.header('authorization')?.match(/^Bearer (.+)$/)?.[1]
    const user = token ? await deps.verifyToken(token) : null
    if (!user) return c.json({ error: 'unauthorized' }, 401)
    if (!user.adult) return c.json({ error: 'adults_only' }, 403)

    const parsed = action.input.safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)

    const quota = await deps.useQuota(user.id, c.req.param('app'))
    if (!quota.allowed) return c.json({ error: 'quota_exceeded' }, 429)

    c.header('X-AI-Format', action.format)
    c.header('X-AI-Remaining', String(quota.remaining))
    return streamText(
      c,
      async (stream) => {
        const controller = new AbortController()
        stream.onAbort(() => {
          controller.abort()
        })
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(AI_TIMEOUT_MS)])
        const chunks = deps.generate({
          system: action.system,
          prompt: action.prompt(parsed.data),
          maxOutputTokens: action.maxOutputTokens,
          signal,
        })
        for await (const chunk of chunks) await stream.write(chunk)
      },
      async (err, stream) => {
        console.error('ai stream failed', err)
        // Headers are already sent, so the client learns about the failure from this marker line.
        await stream.write('\n[[error]]\n')
      },
    )
  })

  return app
}
