import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'
import { streamText } from 'hono/streaming'
import { apps } from './apps/index.js'
import {
  searchQuery,
  SOURCES,
  SourcePending,
  SourceUnavailable,
  isUnsplashDownloadLocation,
  type PhotoPage,
  type SearchQuery,
  type Source,
} from './photos.js'
import { z } from 'zod'
import {
  chartsQuery,
  lookupQuery,
  MusicBusy,
  searchQuery as musicSearchQuery,
  type Music,
} from './music.js'
import { climateQuery, guideQuery, placeQuery, PlacesBusy, type Places } from './places.js'

export interface User {
  id: string
}

export interface Deps {
  allowedOrigins: string[]
  verifyToken: (token: string) => Promise<User | null>
  /** The user confirmed they are 18 or older. Stored server-side in `profiles`, which users can't edit. */
  isAdult: (userId: string) => Promise<boolean>
  confirmAdult: (userId: string) => Promise<void>
  /** Deletes the account; its profile and AI usage go with it (foreign keys cascade). */
  deleteUser: (userId: string) => Promise<void>
  /** Counts one call and says if the user is still within today's quota. */
  useQuota: (userId: string, app: string) => Promise<{ allowed: boolean; remaining: number }>
  countryOf: (ip: string) => string | undefined
  /** Counts one call for this IP and says if it is still within the limit. */
  hitIpLimit: (ip: string) => boolean
  generate: (req: {
    system: string
    prompt: string
    /** Public stock photos only, never user uploads (free-tier prompts may be read by Google). */
    images?: { mimeType: string; data: string }[] | undefined
    maxOutputTokens: number
    signal: AbortSignal
  }) => AsyncIterable<string>
  fetchImage: (url: string) => Promise<{ mimeType: string; data: string }>
  photos: {
    search: (source: Source, q: SearchQuery) => Promise<PhotoPage>
    trackDownload: (downloadLocation: string) => Promise<void>
  }
  /** Cached iTunes search, lookup and charts (Willify). */
  music: Pick<Music, 'search' | 'lookup' | 'charts'>
  /** Cached OpenStreetMap search, Wikivoyage guides and NASA climate averages (Natour). */
  places: Pick<Places, 'search' | 'guide' | 'climate'>
  /** A looser per-IP limit for photo search, which needs no sign-in. */
  hitPhotoIpLimit: (ip: string) => boolean
  /** Adds one view to today's private GitHub profile counter. */
  countProfileView: () => Promise<void>
  /** Generous, since GitHub's image proxy shares a few IPs across all visitors. */
  hitPixelIpLimit: (ip: string) => boolean
}

// The Gemini free tier may not be used to serve people in the EEA, the UK or Switzerland.
// prettier-ignore
export const BLOCKED_COUNTRIES = new Set([
  'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT',
  'NL','PL','PT','RO','SK','SI','ES','SE','IS','LI','NO','GB','CH',
])

// Free-tier Gemini can take 30-50s to start answering. Heroku's router needs headers within 30s (sent at
// once) and then a byte at least every 55s, so we send a keep-alive blank line every 10s and stop at 60s.
const AI_TIMEOUT_MS = 60_000
const KEEP_ALIVE_MS = 10_000

// A transparent 1x1 image, so the pixel is invisible on the profile.
const PIXEL =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1"></svg>'

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

  // Private view counter for the owner's GitHub profile README. The image never fails: a broken image
  // would show on the profile, so a counting error is only logged.
  app.get('/api/hits/github-profile.svg', async (c) => {
    if (deps.hitPixelIpLimit(clientIp(c.req.header('x-forwarded-for')))) {
      await deps.countProfileView().catch((err: unknown) => {
        console.error('profile view count failed', err)
      })
    }
    // No caching anywhere, so GitHub's camo proxy fetches it again on every profile view.
    c.header('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0')
    c.header('Pragma', 'no-cache')
    c.header('Expires', '0')
    c.header('Content-Type', 'image/svg+xml')
    return c.body(PIXEL)
  })

  const userFrom = async (header: string | undefined) => {
    const token = header?.match(/^Bearer (.+)$/)?.[1]
    return token ? deps.verifyToken(token) : null
  }

  // The signed-in user's own account: shared by every EW app.
  app.get('/api/me', async (c) => {
    const user = await userFrom(c.req.header('authorization'))
    if (!user) return c.json({ error: 'unauthorized' }, 401)
    return c.json({ adult: await deps.isAdult(user.id) })
  })

  app.post('/api/me/adult', async (c) => {
    const user = await userFrom(c.req.header('authorization'))
    if (!user) return c.json({ error: 'unauthorized' }, 401)
    await deps.confirmAdult(user.id)
    return c.body(null, 204)
  })

  app.delete('/api/me', async (c) => {
    const user = await userFrom(c.req.header('authorization'))
    if (!user) return c.json({ error: 'unauthorized' }, 401)
    await deps.deleteUser(user.id)
    return c.body(null, 204)
  })

  // Stock photo search, so the Unsplash and Pexels keys stay on the server. No sign-in needed.
  app.get('/api/photos/:source/search', async (c) => {
    const source = SOURCES.find((s) => s === c.req.param('source'))
    if (!source) return c.json({ error: 'unknown_source' }, 404)
    if (!deps.hitPhotoIpLimit(clientIp(c.req.header('x-forwarded-for'))))
      return c.json({ error: 'rate_limited' }, 429)
    const parsed = searchQuery.safeParse(c.req.query())
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
    try {
      const page = await deps.photos.search(source, parsed.data)
      c.header('Cache-Control', 'public, max-age=600')
      return c.json(page)
    } catch (err) {
      if (err instanceof SourceUnavailable) return c.json({ error: 'source_unavailable' }, 503)
      // Still loading upstream: the client asks again shortly and gets the cached result.
      if (err instanceof SourcePending)
        return c.json({ photos: [], hasMore: false, pending: true }, 202)
      console.error('photo search failed', err)
      return c.json({ error: 'upstream_failed' }, 502)
    }
  })

  // iTunes search, lookup and Apple's charts, cached, for Willify. No sign-in. The photo limit is reused: both
  // are cheap cached reads. Only JSON passes through; previews and artwork load from Apple directly.
  const musicRoute =
    <S extends z.ZodType, T>(schema: S, load: (q: z.infer<S>) => Promise<T>, maxAge: number) =>
    async (c: Context) => {
      if (!deps.hitPhotoIpLimit(clientIp(c.req.header('x-forwarded-for'))))
        return c.json({ error: 'rate_limited' }, 429)
      const parsed = schema.safeParse(c.req.query())
      if (!parsed.success)
        return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
      try {
        const value = await load(parsed.data)
        c.header('Cache-Control', `public, max-age=${String(maxAge)}`)
        return c.json({ results: value })
      } catch (err) {
        if (err instanceof MusicBusy) return c.json({ error: 'music_busy' }, 503)
        console.error('music request failed', err)
        return c.json({ error: 'upstream_failed' }, 502)
      }
    }
  app.get(
    '/api/music/search',
    musicRoute(musicSearchQuery, (q) => deps.music.search(q), 3600),
  )
  app.get(
    '/api/music/lookup',
    musicRoute(lookupQuery, (q) => deps.music.lookup(q), 3600),
  )
  app.get(
    '/api/music/charts',
    musicRoute(chartsQuery, (q) => deps.music.charts(q.country), 3600),
  )

  // Natour's place check, guides and climate. No sign-in, cached; Nominatim's 1 request a second is shared
  // by every user (see places.ts), so a long queue answers 503 places_busy rather than hitting their limit.
  const placesRoute =
    <S extends z.ZodType, T>(schema: S, load: (q: z.infer<S>) => Promise<T>, maxAge: number) =>
    async (c: Context) => {
      if (!deps.hitPhotoIpLimit(clientIp(c.req.header('x-forwarded-for'))))
        return c.json({ error: 'rate_limited' }, 429)
      const parsed = schema.safeParse(c.req.query())
      if (!parsed.success)
        return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
      try {
        const value = await load(parsed.data)
        c.header('Cache-Control', `public, max-age=${String(maxAge)}`)
        return c.json({ result: value })
      } catch (err) {
        if (err instanceof PlacesBusy) return c.json({ error: 'places_busy' }, 503)
        console.error('places request failed', err)
        return c.json({ error: 'upstream_failed' }, 502)
      }
    }
  app.get(
    '/api/places/search',
    placesRoute(placeQuery, (q) => deps.places.search(q), 86_400),
  )
  app.get(
    '/api/places/guide',
    placesRoute(guideQuery, (q) => deps.places.guide(q.title), 86_400),
  )
  app.get(
    '/api/places/climate',
    placesRoute(climateQuery, (q) => deps.places.climate(q.lat, q.lon), 604_800),
  )

  // Unsplash asks apps to report each download; the board calls this when a photo is exported.
  app.post('/api/photos/unsplash/download', bodyLimit({ maxSize: 1024 }), async (c) => {
    if (!deps.hitPhotoIpLimit(clientIp(c.req.header('x-forwarded-for'))))
      return c.json({ error: 'rate_limited' }, 429)
    const body = z
      .object({ downloadLocation: z.string().max(300).refine(isUnsplashDownloadLocation) })
      .safeParse(await c.req.json().catch(() => undefined))
    if (!body.success) return c.json({ error: 'invalid_input' }, 400)
    try {
      await deps.photos.trackDownload(body.data.downloadLocation)
      return c.body(null, 204)
    } catch (err) {
      console.error('unsplash download tracking failed', err)
      return c.json({ error: 'upstream_failed' }, 502)
    }
  })

  app.post('/api/ai/:app/:action', bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    const action = apps[c.req.param('app')]?.[c.req.param('action')]
    if (!action) return c.json({ error: 'unknown_action' }, 404)

    const ip = clientIp(c.req.header('x-forwarded-for'))
    const country = deps.countryOf(ip)
    if (country && BLOCKED_COUNTRIES.has(country))
      return c.json({ error: 'region_unavailable' }, 451)
    if (!deps.hitIpLimit(ip)) return c.json({ error: 'rate_limited' }, 429)

    const user = await userFrom(c.req.header('authorization'))
    if (!user) return c.json({ error: 'unauthorized' }, 401)
    if (!(await deps.isAdult(user.id))) return c.json({ error: 'adults_only' }, 403)

    const parsed = action.input.safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)

    // Fetch the image before charging quota, so a dead link costs the user nothing.
    let images: { mimeType: string; data: string }[] | undefined
    const imageUrl = action.image?.(parsed.data)
    if (imageUrl) {
      try {
        images = [await deps.fetchImage(imageUrl)]
      } catch {
        return c.json({ error: 'image_unavailable' }, 422)
      }
    }

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
          images,
          maxOutputTokens: action.maxOutputTokens,
          signal,
        })
        // Blank lines are ignored by JSON Lines readers and trimmed from the start of text replies. They stop
        // at the first chunk, so they never land inside a text reply, where line breaks matter.
        const keepAlive = setInterval(() => void stream.write('\n'), KEEP_ALIVE_MS)
        try {
          for await (const chunk of chunks) {
            clearInterval(keepAlive)
            await stream.write(chunk)
          }
        } finally {
          clearInterval(keepAlive)
        }
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
