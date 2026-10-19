import { GoogleGenAI } from '@google/genai'
import { serve } from '@hono/node-server'
import { createClient } from '@supabase/supabase-js'
import geoip from 'geoip-country'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { z } from 'zod'
import { createApp } from './app.js'
import { createIpLimiter } from './ipLimit.js'

const env = z
  .object({
    PORT: z.coerce.number().default(8787),
    GEMINI_API_KEY: z.string().min(1),
    GEMINI_MODEL: z.string().default('gemini-2.5-flash-lite'),
    SUPABASE_URL: z.url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    ALLOWED_ORIGINS: z.string().transform((s) => s.split(',').map((o) => o.trim())),
    AI_DAILY_QUOTA: z.coerce.number().int().positive().default(30),
    AI_IP_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),
  })
  .parse(process.env)

const gemini = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY })
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})
const jwks = createRemoteJWKSet(new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`))

const app = createApp({
  allowedOrigins: env.ALLOWED_ORIGINS,

  async verifyToken(token) {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: `${env.SUPABASE_URL}/auth/v1`,
        audience: 'authenticated',
      })
      const meta = payload.user_metadata as { adult?: unknown } | undefined
      return payload.sub ? { id: payload.sub, adult: meta?.adult === true } : null
    } catch {
      return null
    }
  },

  async useQuota(userId, appName) {
    const res = await supabase.rpc('use_ai_quota', { p_user: userId, p_app: appName })
    if (res.error) throw res.error
    const used = z.number().parse(res.data as unknown)
    return {
      allowed: used <= env.AI_DAILY_QUOTA,
      remaining: Math.max(0, env.AI_DAILY_QUOTA - used),
    }
  },

  countryOf: (ip) => geoip.lookup(ip)?.country,
  hitIpLimit: createIpLimiter(env.AI_IP_LIMIT_PER_MINUTE, 60_000),

  async *generate({ system, prompt, maxOutputTokens, signal }) {
    const stream = await gemini.models.generateContentStream({
      model: env.GEMINI_MODEL,
      contents: prompt,
      config: { systemInstruction: system, maxOutputTokens, temperature: 0.4, abortSignal: signal },
    })
    for await (const chunk of stream) if (chunk.text) yield chunk.text
  },
})

// Supabase pauses free projects after a week without activity; one tiny query a day keeps it awake.
const ping = () =>
  void supabase.rpc('ping').then(({ error }) => {
    if (error) console.error('supabase ping failed', error.message)
  })
ping()
setInterval(ping, 24 * 60 * 60 * 1000)

serve({ fetch: app.fetch, port: env.PORT }, ({ port }) => {
  console.log(`ew-apps-api on :${String(port)}`)
})
