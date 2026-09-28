import { describe, it, expect, vi, afterEach } from 'vitest'
import { chat } from './api'

afterEach(() => vi.unstubAllGlobals())

describe('chat', () => {
  it('reads a 503 as "busy", so the page can say try later rather than "something went wrong"', async () => {
    // The API answers 503 when Workers AI has spent the day's allocation.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"code":"busy"}', { status: 503 })))
    expect(await chat('hi', [])).toEqual({ ok: false, reason: 'busy' })
  })

  it('still reads any other failure as an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    expect(await chat('hi', [])).toEqual({ ok: false, reason: 'error' })
  })
})
