import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { importSchemeJson } from '../../src/domain/import'
import { RECOVERY_LEASE_MS } from '../../src/application/recovery-session'
import { recoveryReceiptSchema } from '../../src/application/recovery-contract'
import { createRegistryServer } from '../index'
import { RegistryStore } from '../store'

const scheme = importSchemeJson(readFileSync('tests/fixtures/manual-v1.json', 'utf8')).scheme

describe('atomic recovery HTTP compatibility', () => {
  it('preserves ownership/validation error precedence, source isolation and the small receipt', async () => {
    let now = Date.parse('2030-01-01T00:00:00.000Z')
    const store = new RegistryStore(':memory:', () => new Date(now).toISOString())
    const server = createRegistryServer(store, 0)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test address')
    const base = `http://127.0.0.1:${address.port}/api/recovery`
    const ownerId = randomUUID(),
      other = randomUUID(),
      sessionId = randomUUID()
    const input = {
      sessionId,
      ownerId,
      scheme,
      expectedVersion: 0,
      baseRevision: null,
      detailsDraft: null,
      placementDraft: null,
      fileName: 'fictional.json',
    }
    const send = (body: typeof input | Record<string, unknown>) =>
      fetch(`${base}/${String(body.sessionId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' },
        body: JSON.stringify(body),
      })
    try {
      const first = await send(input)
      expect(first.status).toBe(200)
      const receipt = recoveryReceiptSchema.parse(await first.json())
      expect(Object.keys(receipt).sort()).toEqual(['sourceSha256', 'updatedAt', 'version'])
      const before = store.getRecovery(sessionId)
      // The outer transfer is valid; ownership is checked before parsing its unknown Scheme.
      expect(
        (await send({ ...input, scheme: null, ownerId: other, expectedVersion: 1 })).status,
      ).toBe(409)
      expect((await send({ ...input, scheme: null, expectedVersion: 1 })).status).toBe(400)
      now += RECOVERY_LEASE_MS
      expect(
        (await send({ ...input, scheme: null, ownerId: other, expectedVersion: 1 })).status,
      ).toBe(400)
      expect((await send({ ...input, scheme: null })).status).toBe(400)
      expect(store.getRecovery(sessionId)).toEqual(before)

      const foreign = await send({
        ...input,
        sessionId: randomUUID(),
        scheme: {
          ...scheme,
          source: { ...scheme.source, originalJson: '{"fictional":"foreign source"}' },
        },
      })
      const foreignReceipt = recoveryReceiptSchema.parse(await foreign.json())
      if (scheme.source.kind !== 'legacy-html-v1') throw new Error('Expected fictional source')
      const partial = {
        ...scheme,
        source: { kind: scheme.source.kind, importedAt: scheme.source.importedAt },
      }
      const transfer = {
        ...input,
        expectedVersion: 1,
        scheme: partial,
        sourceSha256: receipt.sourceSha256,
      }
      expect((await send({ ...transfer, sourceSha256: foreignReceipt.sourceSha256 })).status).toBe(
        409,
      )
      expect(
        (await send({ ...transfer, sessionId: randomUUID(), expectedVersion: 0 })).status,
      ).toBe(409)
      expect((await send({ ...transfer, scheme })).status).toBe(409)
      expect(store.listRecoveries()).toHaveLength(2)
      expect(store.getRecovery(sessionId)).toEqual(before)
      const saved = await send(transfer)
      expect(saved.status).toBe(200)
      const second = recoveryReceiptSchema.parse(await saved.json())
      expect(second).toMatchObject({ version: 2, sourceSha256: receipt.sourceSha256 })
      expect(JSON.stringify(second).length).toBeLessThan(200)
      expect(store.getRecovery(sessionId, { ownerId })?.scheme).toEqual(scheme)

      const native = await send({
        ...input,
        sessionId: randomUUID(),
        scheme: { ...scheme, source: { kind: 'created-in-editor' } },
      })
      expect(native.status).toBe(200)
      expect(Object.keys(recoveryReceiptSchema.parse(await native.json())).sort()).toEqual([
        'updatedAt',
        'version',
      ])
      expect(store.listProjects()).toEqual([])
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      store.close()
    }
  })
})
