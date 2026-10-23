import { z } from 'zod'

// Natour's place data. All three sources are free and keyless, each with its own etiquette:
// - Nominatim (OSM Foundation): at most 1 request a second for the whole app, an identifying User-Agent,
//   results cached, no autocomplete. So every lookup queues on one shared clock and is cached for a week.
// - Wikivoyage (MediaWiki API): identifying User-Agent, serial requests, cache. Text is CC BY-SA 4.0.
// - NASA POWER climatology: monthly averages of daily highs, lows and rain, 2001-2025 (the _AVG parameters;
//   plain T2M_MAX is the record high). Free, asks for an acknowledgement.

const UA = 'Natour/1.0 (+https://github.com/emwil23/natour; ew-apps-api)'

/** A place that exists on OpenStreetMap. */
export interface Place {
  name: string
  /** OSM's full address line, e.g. "Miradouro da Senhora do Monte, Graça, Lisboa, Portugal". */
  address: string
  lat: number
  lon: number
  /** OSM class and type, e.g. tourism / viewpoint. */
  category: string
  type: string
  /** "node/123", for a link to openstreetmap.org. */
  osm: string
  /** [south, north, west, east]. */
  bbox: [number, number, number, number]
}

const coord = z.coerce.number()
/** west,south,east,north, like Nominatim's viewbox. */
const viewbox = z
  .string()
  .regex(/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/)
  .transform((s) => s.split(',').map(Number) as [number, number, number, number])
  .refine(([w, s, e, n]) => s < n && w < e && Math.abs(s) <= 90 && Math.abs(n) <= 90, 'bad box')

export const placeQuery = z.object({
  q: z.string().trim().min(2).max(160),
  /** Restricts results to this box (the trip's city), so "Time Out Market" means Lisbon's. */
  near: viewbox.optional(),
  limit: z.coerce.number().int().min(1).max(5).default(3),
  lang: z
    .string()
    .regex(/^[a-z]{2}(-[A-Za-z]{2})?$/)
    .default('en'),
})
export type PlaceQuery = z.infer<typeof placeQuery>

export const guideQuery = z.object({ title: z.string().trim().min(2).max(120) })

export const climateQuery = z.object({
  lat: coord.pipe(z.number().min(-90).max(90)),
  lon: coord.pipe(z.number().min(-180).max(180)),
})

const nominatimResult = z.looseObject({
  osm_type: z.string(),
  osm_id: z.number(),
  lat: z.string(),
  lon: z.string(),
  category: z.string().optional(),
  class: z.string().optional(),
  type: z.string(),
  name: z.string().optional(),
  display_name: z.string(),
  boundingbox: z.array(z.string()).length(4),
})

export const parseNominatim = (json: unknown): Place[] =>
  z
    .array(nominatimResult)
    .parse(json)
    .map((r) => ({
      name: r.name || r.display_name.split(',')[0] || r.display_name,
      address: r.display_name,
      lat: Number(r.lat),
      lon: Number(r.lon),
      category: r.category ?? r.class ?? 'place',
      type: r.type,
      osm: `${r.osm_type}/${String(r.osm_id)}`,
      bbox: r.boundingbox.map(Number) as Place['bbox'],
    }))

export function nominatimUrl(q: PlaceQuery): string {
  const u = new URL('https://nominatim.openstreetmap.org/search')
  u.searchParams.set('q', q.q)
  u.searchParams.set('format', 'jsonv2')
  u.searchParams.set('limit', String(q.limit))
  u.searchParams.set('accept-language', q.lang)
  if (q.near) {
    u.searchParams.set('viewbox', q.near.join(','))
    u.searchParams.set('bounded', '1')
  }
  return u.toString()
}

export interface Guide {
  title: string
  extract: string
  /** The article on Wikivoyage, for the CC BY-SA credit and link. */
  url: string
}

const wikiPage = z.object({
  query: z.object({
    pages: z.array(
      z.object({
        title: z.string(),
        missing: z.boolean().optional(),
        extract: z.string().optional(),
      }),
    ),
  }),
})

export function parseGuide(json: unknown): Guide | null {
  const page = wikiPage.parse(json).query.pages[0]
  if (!page || page.missing || !page.extract?.trim()) return null
  return {
    title: page.title,
    extract: page.extract.trim(),
    url: `https://en.wikivoyage.org/wiki/${encodeURIComponent(page.title.replaceAll(' ', '_'))}`,
  }
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const monthly = z.record(z.string(), z.number())
const power = z.object({
  properties: z.object({
    parameter: z.object({ T2M_MAX_AVG: monthly, T2M_MIN_AVG: monthly, PRECTOTCORR: monthly }),
  }),
})

/** One month of averages: daily high and low in °C, rain in mm a day. */
export interface ClimateMonth {
  high: number
  low: number
  rainMm: number
}

export function parseClimate(json: unknown): ClimateMonth[] {
  const p = power.parse(json).properties.parameter
  const value = (m: Record<string, number>, k: string) => {
    const v = m[k]
    // POWER marks missing values with -999.
    if (v === undefined || v <= -999) throw new Error(`climate ${k} missing`)
    return Math.round(v * 10) / 10
  }
  return MONTHS.map((k) => ({
    high: value(p.T2M_MAX_AVG, k),
    low: value(p.T2M_MIN_AVG, k),
    rainMm: value(p.PRECTOTCORR, k),
  }))
}

export class PlacesBusy extends Error {}

/** One request every `gapMs` across all callers; a caller waits up to `maxWaitMs` for its slot. */
export function createClock(
  gapMs: number,
  now = Date.now,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
) {
  let next = 0
  return async (maxWaitMs: number): Promise<boolean> => {
    const t = now()
    const slot = Math.max(t, next)
    if (slot - t > maxWaitMs) return false
    next = slot + gapMs
    if (slot > t) await sleep(slot - t)
    return true
  }
}

/**
 * Cached place search, guides and climate.
 * shortcut: the cache lives in the single dyno's memory and is lost on restart; fine at this scale.
 */
export function createPlaces({
  fetchFn = fetch,
  now = Date.now,
  nominatimTurn = createClock(1100, now),
}: {
  fetchFn?: typeof fetch
  now?: () => number
  nominatimTurn?: (maxWaitMs: number) => Promise<boolean>
} = {}) {
  const cache = new Map<string, { at: number; ttl: number; value: unknown }>()
  const MAX = 5000
  // Two people asking for the same place at once share one upstream call.
  const inflight = new Map<string, Promise<unknown>>()

  async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key)
    if (hit && now() - hit.at < hit.ttl) {
      cache.delete(key)
      cache.set(key, hit)
      return hit.value as T
    }
    const running = inflight.get(key)
    if (running) return running as Promise<T>
    const p = load()
      .then((value) => {
        if (cache.size >= MAX) cache.delete(cache.keys().next().value ?? '')
        cache.set(key, { at: now(), ttl, value })
        return value
      })
      .finally(() => inflight.delete(key))
    inflight.set(key, p)
    return p
  }

  async function get(url: string): Promise<unknown> {
    const res = await fetchFn(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 403 || res.status === 429 || res.status === 503) throw new PlacesBusy()
    if (!res.ok) throw new Error(`${new URL(url).host} ${String(res.status)}`)
    return res.json()
  }

  const DAY = 24 * 60 * 60 * 1000

  return {
    search: (q: PlaceQuery) =>
      cached(
        JSON.stringify(['p', q.q.toLowerCase(), q.near, q.limit, q.lang]),
        7 * DAY,
        async () => {
          // Heroku cuts requests at 30s; a queue longer than 20s means "busy, try again".
          if (!(await nominatimTurn(20_000))) throw new PlacesBusy()
          return parseNominatim(await get(nominatimUrl(q)))
        },
      ),

    guide: (title: string) =>
      cached(JSON.stringify(['g', title.toLowerCase()]), 7 * DAY, async () => {
        const u = new URL('https://en.wikivoyage.org/w/api.php')
        for (const [k, v] of Object.entries({
          action: 'query',
          prop: 'extracts',
          exintro: '1',
          explaintext: '1',
          redirects: '1',
          titles: title,
          format: 'json',
          formatversion: '2',
        }))
          u.searchParams.set(k, v)
        return parseGuide(await get(u.toString()))
      }),

    climate: (lat: number, lon: number) => {
      // About 11 km of rounding: plenty for monthly averages, and nearby trips share the cache.
      const [la, lo] = [lat.toFixed(1), lon.toFixed(1)]
      return cached(JSON.stringify(['c', la, lo]), 30 * DAY, async () =>
        parseClimate(
          await get(
            `https://power.larc.nasa.gov/api/temporal/climatology/point?parameters=T2M_MAX_AVG,T2M_MIN_AVG,PRECTOTCORR&community=RE&longitude=${lo}&latitude=${la}&format=JSON`,
          ),
        ),
      )
    },
  }
}

export type Places = ReturnType<typeof createPlaces>
