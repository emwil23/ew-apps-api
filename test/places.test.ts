import { describe, expect, it, vi } from 'vitest'
import { createApp, type Deps } from '../src/app.js'
import { natour } from '../src/apps/natour.js'
import {
  createClock,
  createPlaces,
  nominatimUrl,
  parseClimate,
  parseGuide,
  parseNominatim,
  placeQuery,
  PlacesBusy,
} from '../src/places.js'

const viewpoint = {
  place_id: 1,
  osm_type: 'node',
  osm_id: 14243536001,
  lat: '38.7190781',
  lon: '-9.1329112',
  category: 'tourism',
  type: 'viewpoint',
  name: 'Miradouro da Senhora do Monte',
  display_name: 'Miradouro da Senhora do Monte, Graça, Lisboa, Portugal',
  boundingbox: ['38.7190281', '38.7191281', '-9.1329612', '-9.1328612'],
}

const months = (v: number) =>
  Object.fromEntries(
    ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC', 'ANN'].map(
      (m) => [m, v],
    ),
  )

describe('parsers', () => {
  it('maps Nominatim results to places', () => {
    expect(parseNominatim([viewpoint])).toEqual([
      {
        name: 'Miradouro da Senhora do Monte',
        address: 'Miradouro da Senhora do Monte, Graça, Lisboa, Portugal',
        lat: 38.7190781,
        lon: -9.1329112,
        category: 'tourism',
        type: 'viewpoint',
        osm: 'node/14243536001',
        bbox: [38.7190281, 38.7191281, -9.1329612, -9.1328612],
      },
    ])
  })

  it('falls back to the first part of the address when a place has no name', () => {
    expect(parseNominatim([{ ...viewpoint, name: '' }])[0]?.name).toBe(
      'Miradouro da Senhora do Monte',
    )
  })

  it('builds a bounded search inside the trip box', () => {
    const q = placeQuery.parse({ q: 'Time Out Market', near: '-9.25,38.69,-9.05,38.8' })
    const url = new URL(nominatimUrl(q))
    expect(url.searchParams.get('viewbox')).toBe('-9.25,38.69,-9.05,38.8')
    expect(url.searchParams.get('bounded')).toBe('1')
    expect(url.searchParams.get('format')).toBe('jsonv2')
    expect(placeQuery.safeParse({ q: 'x y', near: '1,2,3' }).success).toBe(false)
    expect(placeQuery.safeParse({ q: 'x y', near: '-9,39,-10,38' }).success).toBe(false)
  })

  it('reads a Wikivoyage extract with its link, or null for a missing page', () => {
    expect(
      parseGuide({ query: { pages: [{ title: 'Lisbon', extract: 'Lisbon is the capital…' }] } }),
    ).toEqual({
      title: 'Lisbon',
      extract: 'Lisbon is the capital…',
      url: 'https://en.wikivoyage.org/wiki/Lisbon',
    })
    expect(parseGuide({ query: { pages: [{ title: 'Nowhere', missing: true }] } })).toBeNull()
  })

  it('reads twelve months of NASA POWER averages and refuses missing values', () => {
    const json = (rain: number) => ({
      properties: {
        parameter: {
          T2M_MAX_AVG: months(24.94),
          T2M_MIN_AVG: months(9.75),
          PRECTOTCORR: months(rain),
        },
      },
    })
    const climate = parseClimate(json(1.8))
    expect(climate).toHaveLength(12)
    expect(climate[0]).toEqual({ high: 24.9, low: 9.8, rainMm: 1.8 })
    expect(() => parseClimate(json(-999))).toThrow()
  })
})

describe('createClock', () => {
  it('spaces calls one gap apart and turns away callers who would wait too long', async () => {
    let t = 0
    const slept: number[] = []
    const turn = createClock(
      1000,
      () => t,
      (ms) => {
        slept.push(ms)
        return Promise.resolve()
      },
    )
    expect(await turn(5000)).toBe(true)
    expect(await turn(5000)).toBe(true)
    expect(await turn(5000)).toBe(true)
    expect(slept).toEqual([1000, 2000])
    expect(await turn(1500)).toBe(false)
    t = 10_000
    expect(await turn(0)).toBe(true)
  })
})

describe('createPlaces', () => {
  it('caches searches and shares one call between parallel askers', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(new Response(JSON.stringify([viewpoint]))))
    const places = createPlaces({
      fetchFn: fetchFn as unknown as typeof fetch,
      nominatimTurn: () => Promise.resolve(true),
    })
    const q = placeQuery.parse({ q: 'Miradouro da Senhora do Monte' })
    await Promise.all([places.search(q), places.search(q)])
    await places.search({ ...q, q: 'MIRADOURO da Senhora do Monte' })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(new Headers(init.headers).get('user-agent')).toContain('Natour')
  })

  it('says busy when the queue is too long or Nominatim pushes back', async () => {
    const queueFull = createPlaces({ nominatimTurn: () => Promise.resolve(false) })
    await expect(queueFull.search(placeQuery.parse({ q: 'Belém Tower' }))).rejects.toBeInstanceOf(
      PlacesBusy,
    )
    const refused = createPlaces({
      fetchFn: () => Promise.resolve(new Response('', { status: 429 })),
      nominatimTurn: () => Promise.resolve(true),
    })
    await expect(refused.search(placeQuery.parse({ q: 'Belém Tower' }))).rejects.toBeInstanceOf(
      PlacesBusy,
    )
  })

  it('rounds climate lookups to share the cache between nearby trips', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            properties: {
              parameter: {
                T2M_MAX_AVG: months(20),
                T2M_MIN_AVG: months(10),
                PRECTOTCORR: months(2),
              },
            },
          }),
        ),
      ),
    )
    const places = createPlaces({ fetchFn: fetchFn as unknown as typeof fetch })
    await places.climate(38.7223, -9.1393)
    await places.climate(38.7189, -9.1421)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect((fetchFn.mock.calls[0] as unknown as [string])[0]).toContain('latitude=38.7&')
  })
})

describe('/api/places routes', () => {
  const setup = (places: Partial<Deps['places']> = {}) => {
    const deps = {
      allowedOrigins: ['http://localhost:5173'],
      hitPhotoIpLimit: () => true,
      places: {
        search: vi.fn(() => Promise.resolve(parseNominatim([viewpoint]))),
        guide: vi.fn(() => Promise.resolve(null)),
        climate: vi.fn(() => Promise.resolve([])),
        ...places,
      },
    } as unknown as Deps
    return { app: createApp(deps), deps }
  }

  it('validates and answers with cacheable JSON', async () => {
    const { app, deps } = setup()
    const res = await app.request('/api/places/search?q=Miradouro&near=-9.25,38.69,-9.05,38.8')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('max-age=86400')
    expect(((await res.json()) as { result: unknown[] }).result).toHaveLength(1)
    expect(deps.places.search).toHaveBeenCalledWith({
      q: 'Miradouro',
      near: [-9.25, 38.69, -9.05, 38.8],
      limit: 3,
      lang: 'en',
    })
    expect((await app.request('/api/places/search?q=a')).status).toBe(400)
    expect((await app.request('/api/places/climate?lat=95&lon=0')).status).toBe(400)
    expect((await app.request('/api/places/climate?lat=38.7&lon=-9.1')).status).toBe(200)
    expect(deps.places.climate).toHaveBeenCalledWith(38.7, -9.1)
    expect((await app.request('/api/places/guide?title=Lisbon')).status).toBe(200)
  })

  it('answers 503 when Nominatim is busy and 429 over the IP limit', async () => {
    const { app } = setup({ search: () => Promise.reject(new PlacesBusy()) })
    expect((await app.request('/api/places/search?q=Belém Tower')).status).toBe(503)
    const limited = createApp({
      allowedOrigins: [],
      hitPhotoIpLimit: () => false,
    } as unknown as Deps)
    expect((await limited.request('/api/places/search?q=Belém Tower')).status).toBe(429)
  })
})

describe('natour prompts', () => {
  it('keeps the trip description inside <data> and sizes the day to the effort', () => {
    const input = natour.plan.input.parse({
      description: '5 days in Lisbon, food and viewpoints',
      days: 5,
      effort: 'easy',
    })
    const prompt = natour.plan.prompt(input)
    expect(prompt).toContain('5 days')
    expect(prompt).toContain('3 to 4')
    expect(prompt.indexOf('<data>')).toBeLessThan(prompt.indexOf('food and viewpoints'))
  })

  it('caps inputs and rejects bad currencies', () => {
    expect(natour.plan.input.safeParse({ description: 'x', days: 30 }).success).toBe(false)
    expect(
      natour.budget.input.safeParse({
        destination: 'Lisbon',
        days: 3,
        style: 'mid',
        currency: 'euro',
      }).success,
    ).toBe(false)
  })
})
