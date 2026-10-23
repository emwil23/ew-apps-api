import { z } from 'zod'

// Apple's iTunes Search API and the Apple Marketing Tools charts feed. No key, but Apple asks for about 20
// calls a minute and asks large sites to cache, so every call goes through one shared, cached limiter here.
// Only the JSON is cached: previews and artwork stay on Apple's servers (their terms forbid re-hosting).

const UA = 'Willify/1.0 (+https://github.com/emwil23/Willify)'

/** One song, trimmed to what the apps show. URLs all point at Apple. */
export interface Track {
  id: number
  title: string
  artist: string
  artistId: number | null
  album: string | null
  albumId: number | null
  /** 100x100 artwork; clients may ask the same CDN for a larger size and fall back to this. */
  artwork: string | null
  /** 30-second preview, streamed from Apple. */
  previewUrl: string | null
  /** The song on Apple Music. */
  url: string
  genre: string | null
  year: number | null
  durationMs: number | null
  explicit: boolean
}

export interface Album {
  id: number
  title: string
  artist: string
  artistId: number | null
  artwork: string | null
  url: string
  genre: string | null
  year: number | null
  trackCount: number | null
}

export interface Artist {
  id: number
  name: string
  genre: string | null
  url: string
}

export type MusicItem =
  ({ kind: 'track' } & Track) | ({ kind: 'album' } & Album) | ({ kind: 'artist' } & Artist)

const country = z
  .string()
  .regex(/^[a-zA-Z]{2}$/)
  .transform((s) => s.toUpperCase())
  .default('US')

export const searchQuery = z.object({
  term: z.string().trim().min(1).max(100),
  entity: z.enum(['song', 'album', 'musicArtist']).default('song'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  country,
})
export type SearchQuery = z.infer<typeof searchQuery>

export const lookupQuery = z.object({
  /** Up to 50 numeric ids, comma separated (iTunes looks them all up in one call). */
  id: z
    .string()
    .regex(/^\d{1,12}(,\d{1,12}){0,49}$/, 'comma-separated numeric ids')
    .transform((s) => [...new Set(s.split(','))].join(',')),
  /** With an album id: its songs. With an artist id: their songs or albums. */
  entity: z.enum(['song', 'album']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  country,
})
export type LookupQuery = z.infer<typeof lookupQuery>

export const chartsQuery = z.object({
  country: z
    .string()
    .regex(/^[a-zA-Z]{2}$/)
    .transform((s) => s.toLowerCase())
    .default('us'),
})

const result = z.looseObject({
  wrapperType: z.string().optional(),
  kind: z.string().optional(),
  trackId: z.number().optional(),
  trackName: z.string().optional(),
  artistId: z.number().optional(),
  artistName: z.string().optional(),
  collectionId: z.number().optional(),
  collectionName: z.string().optional(),
  artworkUrl100: z.string().optional(),
  previewUrl: z.string().optional(),
  trackViewUrl: z.string().optional(),
  collectionViewUrl: z.string().optional(),
  artistLinkUrl: z.string().optional(),
  artistViewUrl: z.string().optional(),
  primaryGenreName: z.string().optional(),
  releaseDate: z.string().optional(),
  trackTimeMillis: z.number().optional(),
  trackExplicitness: z.string().optional(),
  trackCount: z.number().optional(),
})
const page = z.object({ results: z.array(result) })

const year = (date?: string) => (date ? Number(date.slice(0, 4)) || null : null)
// iTunes links carry `uo` tracking and app-store params we don't need; the apps add their own.
const clean = (url: string) => {
  const u = new URL(url)
  u.searchParams.delete('uo')
  return u.toString()
}

/** Maps one iTunes result to our shape, or null for kinds we don't show (podcasts, videos, etc.). */
export function fromItunes(r: z.infer<typeof result>): MusicItem | null {
  if (r.wrapperType === 'track' && r.kind === 'song' && r.trackId && r.trackName && r.trackViewUrl)
    return {
      kind: 'track',
      id: r.trackId,
      title: r.trackName,
      artist: r.artistName ?? 'Unknown artist',
      artistId: r.artistId ?? null,
      album: r.collectionName ?? null,
      albumId: r.collectionId ?? null,
      artwork: r.artworkUrl100 ?? null,
      previewUrl: r.previewUrl ?? null,
      url: clean(r.trackViewUrl),
      genre: r.primaryGenreName ?? null,
      year: year(r.releaseDate),
      durationMs: r.trackTimeMillis ?? null,
      explicit: r.trackExplicitness === 'explicit',
    }
  if (r.wrapperType === 'collection' && r.collectionId && r.collectionName && r.collectionViewUrl)
    return {
      kind: 'album',
      id: r.collectionId,
      title: r.collectionName,
      artist: r.artistName ?? 'Unknown artist',
      artistId: r.artistId ?? null,
      artwork: r.artworkUrl100 ?? null,
      url: clean(r.collectionViewUrl),
      genre: r.primaryGenreName ?? null,
      year: year(r.releaseDate),
      trackCount: r.trackCount ?? null,
    }
  const artistUrl = r.artistLinkUrl ?? r.artistViewUrl
  if (r.wrapperType === 'artist' && r.artistId && r.artistName && artistUrl)
    return {
      kind: 'artist',
      id: r.artistId,
      name: r.artistName,
      genre: r.primaryGenreName ?? null,
      url: clean(artistUrl),
    }
  return null
}

export const parseItunes = (json: unknown): MusicItem[] =>
  page
    .parse(json)
    .results.map(fromItunes)
    .filter((x): x is MusicItem => x !== null)

export function itunesUrl(path: 'search' | 'lookup', q: SearchQuery | LookupQuery): string {
  const u = new URL(`https://itunes.apple.com/${path}`)
  if ('term' in q) {
    u.searchParams.set('term', q.term)
    u.searchParams.set('media', 'music')
    u.searchParams.set('entity', q.entity)
  } else {
    u.searchParams.set('id', q.id)
    if (q.entity) u.searchParams.set('entity', q.entity)
  }
  u.searchParams.set('limit', String(q.limit))
  u.searchParams.set('country', q.country)
  return u.toString()
}

const chartFeed = z.object({
  feed: z.object({ results: z.array(z.object({ id: z.string() })) }),
})

export class MusicBusy extends Error {}

/**
 * A token bucket shared by every user: `perMinute` calls, refilled continuously. `take` waits up to
 * `maxWaitMs` for a token, so short bursts queue instead of failing.
 */
export function createBucket(
  perMinute: number,
  now = Date.now,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
) {
  let tokens = perMinute
  let last = now()
  const refill = () => {
    const t = now()
    tokens = Math.min(perMinute, tokens + ((t - last) * perMinute) / 60_000)
    last = t
  }
  return async (maxWaitMs: number): Promise<boolean> => {
    const deadline = now() + maxWaitMs
    for (;;) {
      refill()
      if (tokens >= 1) {
        tokens -= 1
        return true
      }
      const wait = ((1 - tokens) * 60_000) / perMinute
      if (now() + wait > deadline) return false
      await sleep(wait)
    }
  }
}

/**
 * Cached iTunes search, lookup and charts.
 * shortcut: the cache lives in the single dyno's memory and is lost on restart; fine at this scale.
 */
export function createMusic({
  fetchFn = fetch,
  perMinute = 20,
  now = Date.now,
  take = createBucket(perMinute, now),
}: {
  fetchFn?: typeof fetch
  perMinute?: number
  now?: () => number
  take?: (maxWaitMs: number) => Promise<boolean>
} = {}) {
  const cache = new Map<string, { at: number; ttl: number; value: unknown }>()
  const MAX = 3000

  async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key)
    if (hit && now() - hit.at < hit.ttl) {
      // Refresh its place, so the map's insertion order works as an LRU.
      cache.delete(key)
      cache.set(key, hit)
      return hit.value as T
    }
    const value = await load()
    if (cache.size >= MAX) cache.delete(cache.keys().next().value ?? '')
    cache.set(key, { at: now(), ttl, value })
    return value
  }

  async function get(url: string): Promise<unknown> {
    // Heroku cuts requests at 30s, so wait at most 15s for a turn.
    if (!(await take(15_000))) throw new MusicBusy()
    const res = await fetchFn(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 403 || res.status === 429) throw new MusicBusy()
    if (!res.ok) throw new Error(`itunes ${String(res.status)}`)
    return res.json()
  }

  const HOUR = 60 * 60 * 1000

  return {
    search: (q: SearchQuery) =>
      cached(
        JSON.stringify(['s', q.term.toLowerCase(), q.entity, q.limit, q.country]),
        12 * HOUR,
        async () => parseItunes(await get(itunesUrl('search', q))),
      ),

    lookup: (q: LookupQuery) =>
      cached(JSON.stringify(['l', q.id, q.entity, q.limit, q.country]), 24 * HOUR, async () =>
        parseItunes(await get(itunesUrl('lookup', q))),
      ),

    /** Apple's most-played songs, looked up in one call so they come with previews. */
    charts: (countryCode: string) =>
      cached(JSON.stringify(['c', countryCode]), 6 * HOUR, async () => {
        const feed = chartFeed.parse(
          await get(
            `https://rss.marketingtools.apple.com/api/v2/${countryCode}/music/most-played/50/songs.json`,
          ),
        )
        const ids = feed.feed.results.map((r) => r.id).join(',')
        if (!ids) return []
        return parseItunes(
          await get(
            itunesUrl('lookup', { id: ids, limit: 50, country: countryCode.toUpperCase() }),
          ),
        ).filter((x) => x.kind === 'track')
      }),
  }
}

export type Music = ReturnType<typeof createMusic>
