import { z } from 'zod'

export const SOURCES = ['unsplash', 'pexels', 'openverse'] as const
export type Source = (typeof SOURCES)[number]

/** One stock photo in the same shape whatever its source. Image URLs point at the source's CDN (no re-hosting). */
export interface Photo {
  id: string
  source: Source
  width: number
  height: number
  /** Average colour as #rrggbb, for the placeholder while the image loads. */
  color: string | null
  alt: string
  /** ~400px wide, for grids. */
  thumb: string
  /** ~1080px wide, for the board. */
  src: string
  /** The photo's page on its source. */
  pageUrl: string
  author: { name: string; url: string | null }
  /** Openverse only: Unsplash and Pexels photos are under their own free licences. */
  license: { name: string; url: string } | null
  /** Unsplash only: must be hit when the user downloads or exports the photo. */
  downloadLocation: string | null
}

export interface PhotoPage {
  photos: Photo[]
  hasMore: boolean
}

export const searchQuery = z.object({
  q: z.string().trim().min(1).max(100),
  page: z.coerce.number().int().min(1).max(20).default(1),
  orientation: z.enum(['landscape', 'portrait', 'square']).optional(),
  /** Named colour; each source maps it to its own filter. */
  color: z
    .enum(['black', 'white', 'yellow', 'orange', 'red', 'purple', 'pink', 'green', 'teal', 'blue'])
    .optional(),
  /** Openverse only; Unsplash and Pexels photos are all free for commercial use. */
  license: z.enum(['any', 'commercial', 'modification']).default('any'),
})
export type SearchQuery = z.infer<typeof searchQuery>

const PER_PAGE = 24
const UA = 'Pixe/1.0 (+https://github.com/emwil23/pixe)'

// --- Unsplash: https://unsplash.com/documentation#search-photos ---

const unsplashPhoto = z.object({
  id: z.string(),
  width: z.number(),
  height: z.number(),
  color: z.string().nullable(),
  description: z.string().nullable(),
  alt_description: z.string().nullable(),
  urls: z.object({ small: z.string(), regular: z.string() }),
  links: z.object({ html: z.string(), download_location: z.string() }),
  user: z.object({ name: z.string(), links: z.object({ html: z.string() }) }),
})
const unsplashPage = z.object({ total_pages: z.number(), results: z.array(unsplashPhoto) })

export const fromUnsplash = (p: z.infer<typeof unsplashPhoto>): Photo => ({
  id: `unsplash:${p.id}`,
  source: 'unsplash',
  width: p.width,
  height: p.height,
  color: p.color,
  alt: p.alt_description ?? p.description ?? '',
  thumb: p.urls.small,
  src: p.urls.regular,
  pageUrl: p.links.html,
  author: { name: p.user.name, url: p.user.links.html },
  license: null,
  downloadLocation: p.links.download_location,
})

// --- Pexels: https://www.pexels.com/api/documentation/#photos-search ---

const pexelsPhoto = z.object({
  id: z.number(),
  width: z.number(),
  height: z.number(),
  url: z.string(),
  photographer: z.string(),
  photographer_url: z.string(),
  avg_color: z.string().nullable(),
  alt: z.string().nullable(),
  src: z.object({ medium: z.string(), large: z.string(), large2x: z.string() }),
})
const pexelsPage = z.object({ photos: z.array(pexelsPhoto), next_page: z.string().optional() })

export const fromPexels = (p: z.infer<typeof pexelsPhoto>): Photo => ({
  id: `pexels:${String(p.id)}`,
  source: 'pexels',
  width: p.width,
  height: p.height,
  color: p.avg_color,
  alt: p.alt ?? '',
  thumb: p.src.large,
  src: p.src.large2x,
  pageUrl: p.url,
  author: { name: p.photographer, url: p.photographer_url },
  license: null,
  downloadLocation: null,
})

// --- Openverse: https://api.openverse.org/v1/#tag/images ---

const openversePhoto = z.object({
  id: z.string(),
  title: z.string().nullable(),
  foreign_landing_url: z.string(),
  url: z.string(),
  thumbnail: z.string(),
  creator: z.string().nullable(),
  creator_url: z.string().nullable(),
  license: z.string(),
  license_version: z.string().nullable(),
  license_url: z.string().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
})
const openversePage = z.object({ page_count: z.number(), results: z.array(openversePhoto) })

export const fromOpenverse = (p: z.infer<typeof openversePhoto>): Photo => {
  const code = p.license.toLowerCase()
  const name = ['cc0', 'pdm'].includes(code)
    ? code === 'cc0'
      ? 'CC0'
      : 'Public Domain Mark'
    : `CC ${code.toUpperCase()}${p.license_version ? ` ${p.license_version}` : ''}`
  return {
    id: `openverse:${p.id}`,
    source: 'openverse',
    width: p.width ?? 1024,
    height: p.height ?? 768,
    color: null,
    alt: p.title ?? '',
    // The thumbnail is served by Openverse itself; the original may be on any host.
    thumb: p.thumbnail,
    src: p.url,
    pageUrl: p.foreign_landing_url,
    author: { name: p.creator ?? 'Unknown', url: p.creator_url },
    license: { name, url: p.license_url ?? 'https://creativecommons.org/licenses/' },
    downloadLocation: null,
  }
}

// Each source names its colour filters a little differently.
const PEXELS_COLOR: Partial<Record<string, string>> = { teal: 'turquoise' }
const UNSPLASH_ORIENTATION = { landscape: 'landscape', portrait: 'portrait', square: 'squarish' }
const OPENVERSE_ASPECT = { landscape: 'wide', portrait: 'tall', square: 'square' }

export interface PhotoKeys {
  unsplash?: string | undefined
  pexels?: string | undefined
}

export class SourceUnavailable extends Error {}

/** Builds the upstream request for a search. Exported so the URL rules can be tested without the network. */
export function upstreamRequest(source: Source, q: SearchQuery, keys: PhotoKeys) {
  const params = new URLSearchParams({ page: String(q.page) })
  switch (source) {
    case 'unsplash': {
      if (!keys.unsplash) throw new SourceUnavailable('unsplash')
      params.set('query', q.q)
      params.set('per_page', String(PER_PAGE))
      params.set('content_filter', 'high')
      if (q.orientation) params.set('orientation', UNSPLASH_ORIENTATION[q.orientation])
      if (q.color) params.set('color', q.color)
      return {
        url: `https://api.unsplash.com/search/photos?${params.toString()}`,
        headers: { Authorization: `Client-ID ${keys.unsplash}`, 'Accept-Version': 'v1' },
      }
    }
    case 'pexels': {
      if (!keys.pexels) throw new SourceUnavailable('pexels')
      params.set('query', q.q)
      params.set('per_page', String(PER_PAGE))
      if (q.orientation) params.set('orientation', q.orientation)
      if (q.color) params.set('color', PEXELS_COLOR[q.color] ?? q.color)
      return {
        url: `https://api.pexels.com/v1/search?${params.toString()}`,
        headers: { Authorization: keys.pexels },
      }
    }
    case 'openverse': {
      params.set('q', q.q)
      params.set('page_size', '20') // the anonymous maximum
      params.set('mature', 'false')
      if (q.orientation) params.set('aspect_ratio', OPENVERSE_ASPECT[q.orientation])
      if (q.license !== 'any') params.set('license_type', q.license)
      // Openverse has no colour filter; the colour goes into the query instead.
      if (q.color) params.set('q', `${q.q} ${q.color}`)
      return { url: `https://api.openverse.org/v1/images/?${params.toString()}`, headers: {} }
    }
  }
}

export function parseUpstream(source: Source, json: unknown, page: number): PhotoPage {
  switch (source) {
    case 'unsplash': {
      const p = unsplashPage.parse(json)
      return { photos: p.results.map(fromUnsplash), hasMore: page < p.total_pages }
    }
    case 'pexels': {
      const p = pexelsPage.parse(json)
      return { photos: p.photos.map(fromPexels), hasMore: Boolean(p.next_page) }
    }
    case 'openverse': {
      const p = openversePage.parse(json)
      return { photos: p.results.map(fromOpenverse), hasMore: page < p.page_count }
    }
  }
}

/** Unsplash requires this call whenever a user downloads (or exports) a photo. */
export const isUnsplashDownloadLocation = (url: string) =>
  /^https:\/\/api\.unsplash\.com\/photos\/[\w-]+\/download(\?[\w=&%.-]*)?$/.test(url)

/**
 * Search with an in-memory cache. Pexels allows 200 calls an hour and Openverse 200 a day without a key,
 * shared by every user, so identical searches must not hit them twice.
 * shortcut: the cache lives in the single dyno's memory and is lost on restart; fine at this scale.
 */
export function createPhotoSearch(
  keys: PhotoKeys,
  fetchFn: typeof fetch = fetch,
  ttlMs = 60 * 60 * 1000,
  now = Date.now,
) {
  const cache = new Map<string, { at: number; value: PhotoPage }>()
  const MAX = 500

  return {
    async search(source: Source, q: SearchQuery): Promise<PhotoPage> {
      const key = JSON.stringify([source, q])
      const hit = cache.get(key)
      if (hit && now() - hit.at < ttlMs) return hit.value

      const req = upstreamRequest(source, q, keys)
      const res = await fetchFn(req.url, {
        headers: { ...req.headers, 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      })
      if (res.status === 429) throw new SourceUnavailable(`${source} rate limited`)
      if (!res.ok) throw new Error(`${source} search failed: ${String(res.status)}`)
      const value = parseUpstream(source, await res.json(), q.page)

      if (cache.size >= MAX) cache.delete(cache.keys().next().value ?? '')
      cache.set(key, { at: now(), value })
      return value
    },

    async trackDownload(downloadLocation: string): Promise<void> {
      if (!keys.unsplash) throw new SourceUnavailable('unsplash')
      const res = await fetchFn(downloadLocation, {
        headers: { Authorization: `Client-ID ${keys.unsplash}`, 'User-Agent': UA },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`unsplash download tracking failed: ${String(res.status)}`)
    },
  }
}

// --- Images for the AI "describe" action ---

/** Only public stock photo CDNs, so the server can't be pointed at arbitrary URLs. */
const IMAGE_HOSTS = new Set(['images.unsplash.com', 'images.pexels.com', 'api.openverse.org'])
const MAX_IMAGE_BYTES = 4 * 1024 * 1024

export const isStockImageUrl = (raw: string) => {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' && IMAGE_HOSTS.has(u.hostname) && !u.username && !u.port
  } catch {
    return false
  }
}

/** Fetches a public stock photo, small, as base64 for Gemini. */
export async function fetchStockImage(raw: string, fetchFn: typeof fetch = fetch) {
  if (!isStockImageUrl(raw)) throw new Error('not a stock image url')
  const u = new URL(raw)
  // Ask the CDNs for a small copy: the model doesn't need more, and it keeps the request quick.
  if (u.hostname === 'images.unsplash.com') {
    u.searchParams.set('w', '512')
    u.searchParams.set('fm', 'jpg')
  }
  if (u.hostname === 'images.pexels.com') u.searchParams.set('w', '512')
  const res = await fetchFn(u, {
    headers: { 'User-Agent': UA },
    redirect: 'manual', // a redirect could leave the allowed hosts
    signal: AbortSignal.timeout(10_000),
  })
  const mimeType = res.headers.get('content-type')?.split(';')[0] ?? ''
  if (!res.ok || !/^image\/(jpeg|png|webp)$/.test(mimeType)) throw new Error('image fetch failed')
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength > MAX_IMAGE_BYTES) throw new Error('image too large')
  return { mimeType, data: buf.toString('base64') }
}
