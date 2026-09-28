import { describe, expect, it } from 'vitest'
import { localJson } from '../json-response'

describe('local API response contract', () => {
  it('reports an HTML proxy response as a local API problem', async () => {
    const response = new Response('<!doctype html>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
    await expect(localJson(response)).rejects.toThrow('вернул не JSON')
  })

  it('reports corrupt JSON without a raw SyntaxError', async () => {
    const response = new Response('{', { headers: { 'Content-Type': 'application/json' } })
    await expect(localJson(response)).rejects.toThrow('повреждённый JSON')
  })
})
