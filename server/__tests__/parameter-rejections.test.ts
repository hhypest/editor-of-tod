import { describe, expect, it } from 'vitest'
import { createRegistryServer } from '../index'
import { RegistryStore } from '../store'
import { DiagnosticsLog } from '../diagnostics'
import { textPdf } from './pdf-fixture'
import { parameterStateSchema } from '../../src/domain/normative-parameters'

describe('parameter confirmation rejection contract', () => {
  it('returns field-specific reasons, records only fixed codes, and rejects a changed document', async () => {
    const store = new RegistryStore(':memory:')
    const log = new DiagnosticsLog(null, { version: 'test', mode: 'test' })
    const server = createRegistryServer(store, 0, undefined, log)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing address')
    const input = {
      value: 250,
      confirmedBy: 'Учебная станция /private/user',
      note: '',
      expectedDocumentId: null as number | null,
    }
    const post = (id: string, body: unknown = input) =>
      fetch(`http://127.0.0.1:${address.port}/api/normative-parameters/${id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' },
        body: JSON.stringify(body),
      })
    const expectRejection = async (
      response: Response,
      reason: string,
      field: string,
      status = 400,
    ) => {
      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({ reason, field, error: expect.any(String) })
      expect(store.listParameterConfirmations()).toHaveLength(0)
    }
    try {
      await expectRejection(await post('odm-signs-hourly'), 'no-document', 'document')
      await expectRejection(
        await post('odm-signs-hourly', { ...input, value: 0 }),
        'invalid-value',
        'value',
      )
      await expectRejection(
        await post('odm-signs-hourly', { ...input, confirmedBy: '' }),
        'invalid-request',
        'confirmedBy',
      )
      await expectRejection(
        await post('peak-hour-share', { ...input, value: 0.1 }),
        'note-required',
        'note',
      )
      await expectRejection(
        await post('rail-crossing-profile'),
        'unknown-parameter',
        'request',
        404,
      )
      const states = parameterStateSchema
        .array()
        .parse(
          await (await fetch(`http://127.0.0.1:${address.port}/api/normative-parameters`)).json(),
        )
      expect(states.some((state: { id: string }) => state.id === 'rail-crossing-profile')).toBe(
        false,
      )
      await expectRejection(await post('private-unknown'), 'unknown-parameter', 'request', 404)
      const meta = {
        code: 'ОДМ 218.6.019',
        edition: '2020',
        title: 'Учебная методика',
        kind: 'methodology' as const,
        effectiveFrom: '',
        amendsId: null,
        note: '',
        actualCheckedAt: '',
      }
      const old = store.addDocument(
        meta,
        'private.pdf',
        textPdf([['Учебная методика без нужного пункта']]),
        'a'.repeat(64),
      )
      await expectRejection(
        await post('odm-signs-hourly', { ...input, expectedDocumentId: old.id }),
        'source-not-found',
        'note',
      )
      store.addDocument(
        { ...meta, edition: '2021' },
        'private-new.pdf',
        textPdf([['Учебная новая методика']]),
        'b'.repeat(64),
      )
      await expectRejection(
        await post('odm-signs-hourly', {
          ...input,
          expectedDocumentId: old.id,
          note: 'private reason',
        }),
        'document-changed',
        'document',
        409,
      )
      const report = JSON.stringify(log.report(store))
      expect(report).toContain('source-not-found')
      expect(report).toContain('odm-signs-hourly')
      expect(report).not.toMatch(/Учебная|private|PDF|формулировку/)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      store.close()
    }
  })
})
