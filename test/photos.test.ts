import { describe, expect, it, vi } from 'vitest'
import {
  createPhotoSearch,
  fetchStockImage,
  fromOpenverse,
  SourcePending,
  isStockImageUrl,
  upstreamRequest,
  type SearchQuery,
} from '../src/photos.js'

const q = (over: Partial<SearchQuery> = {}): SearchQuery => ({
  q: 'autumn cafe',
  page: 1,
  license: 'any',
  ...over,
})

const unsplashJson = {
  total_pages: 3,
  results: [
    {
      id: 'abc',
      width: 4000,
      height: 6000,
      color: '#8c5a3c',
      description: null,
      alt_description: 'latte on a wooden table',
      urls: { small: 'https://images.unsplash.com/s', regular: 'https://images.unsplash.com/r' },
      links: {
        html: 'https://unsplash.com/photos/abc',
        download_location: 'https://api.unsplash.com/photos/abc/download',
      },
      user: { name: 'Ana Lee', links: { html: 'https://unsplash.com/@ana' } },
    },
  ],
}

describe('upstreamRequest', () => {
  it('maps the shared filters to each source', () => {
    const keys = { unsplash: 'u', pexels: 'p' }
    const f = q({ orientation: 'square', color: 'teal', license: 'commercial' })
    const u = upstreamRequest('unsplash', f, keys)
    expect(new URL(u.url).searchParams.get('orientation')).toBe('squarish')
    expect(u.headers).toMatchObject({ Authorization: 'Client-ID u' })
    expect(new URL(upstreamRequest('pexels', f, keys).url).searchParams.get('color')).toBe(
      'turquoise',
    )
    const o = new URL(upstreamRequest('openverse', f, keys).url).searchParams
    expect([o.get('aspect_ratio'), o.get('license_type'), o.get('mature')]).toEqual([
      'square',
      'commercial',
      'false',
    ])
    expect(o.get('q')).toBe('autumn cafe teal')
  })

  it('refuses sources without a key', () => {
    expect(() => upstreamRequest('unsplash', q(), {})).toThrow('unsplash')
    expect(() => upstreamRequest('openverse', q(), {})).not.toThrow()
  })
})

describe('createPhotoSearch', () => {
  it('normalises results and caches identical searches', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(Response.json(unsplashJson)))
    const photos = createPhotoSearch({ unsplash: 'k' }, fetchFn)
    const page = await photos.search('unsplash', q())
    expect(page.hasMore).toBe(true)
    expect(page.photos[0]).toMatchObject({
      id: 'unsplash:abc',
      alt: 'latte on a wooden table',
      author: { name: 'Ana Lee', url: 'https://unsplash.com/@ana' },
      downloadLocation: 'https://api.unsplash.com/photos/abc/download',
    })
    await photos.search('unsplash', q())
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('answers pending for a slow source, then serves the result it kept loading', async () => {
    let finish: (r: Response) => void = () => undefined
    const fetchFn = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    )
    const photos = createPhotoSearch({ unsplash: 'k' }, fetchFn, 60_000, Date.now, 20)
    await expect(photos.search('unsplash', q())).rejects.toBeInstanceOf(SourcePending)
    // A retry while it is still loading joins the same upstream call.
    await expect(photos.search('unsplash', q())).rejects.toBeInstanceOf(SourcePending)
    finish(Response.json(unsplashJson))
    await new Promise((r) => setTimeout(r, 0))
    expect((await photos.search('unsplash', q())).photos).toHaveLength(1)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('reports upstream rate limits as unavailable', async () => {
    const fetchFn = () => Promise.resolve(new Response('', { status: 429 }))
    const photos = createPhotoSearch({ pexels: 'k' }, fetchFn)
    await expect(photos.search('pexels', q())).rejects.toThrow('rate limited')
  })
})

describe('fromOpenverse', () => {
  it('names the licence', () => {
    const base = {
      id: '1',
      title: 'Forest',
      foreign_landing_url: 'https://flickr.com/1',
      url: 'https://live.staticflickr.com/1.jpg',
      thumbnail: 'https://api.openverse.org/v1/images/1/thumb/',
      creator: 'barnyz',
      creator_url: null,
      license_url: 'https://creativecommons.org/licenses/by-nc-nd/2.0/',
      width: 1024,
      height: 683,
    }
    const nd = fromOpenverse({ ...base, license: 'by-nc-nd', license_version: '2.0' })
    expect(nd.license?.name).toBe('CC BY-NC-ND 2.0')
    expect(fromOpenverse({ ...base, license: 'cc0', license_version: '1.0' }).license?.name).toBe(
      'CC0',
    )
  })
})

describe('stock image fetching', () => {
  it('allows only the stock CDNs over https', () => {
    expect(isStockImageUrl('https://images.pexels.com/photos/1/a.jpeg')).toBe(true)
    expect(isStockImageUrl('https://api.openverse.org/v1/images/1/thumb/')).toBe(true)
    expect(isStockImageUrl('https://images.unsplash.com.evil.example/a')).toBe(false)
    expect(isStockImageUrl('https://user@images.unsplash.com/a')).toBe(false)
    expect(isStockImageUrl('http://images.unsplash.com/a')).toBe(false)
    expect(isStockImageUrl('file:///etc/passwd')).toBe(false)
  })

  it('asks for a small copy and refuses non-images', async () => {
    const fetchFn = vi.fn((url: URL) => {
      const ok = url.hostname === 'images.unsplash.com'
      return Promise.resolve(
        new Response(ok ? 'jpg' : '<html>', {
          headers: { 'content-type': ok ? 'image/jpeg' : 'text/html' },
        }),
      )
    })
    const f = fetchFn as unknown as typeof fetch
    const img = await fetchStockImage('https://images.unsplash.com/photo-1?w=4000', f)
    expect(img).toEqual({ mimeType: 'image/jpeg', data: Buffer.from('jpg').toString('base64') })
    expect(fetchFn.mock.calls[0]?.[0].searchParams.get('w')).toBe('512')
    await expect(fetchStockImage('https://images.pexels.com/photos/1/a.jpeg', f)).rejects.toThrow()
  })
})
