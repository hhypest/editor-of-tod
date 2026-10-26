import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { importSchemeJson } from '../../src/domain/import'
import { createSchemeDetailsDraft } from '../../src/domain/edit-details'
import type { Pu66LifecycleWrite } from '../../src/domain/pu66-lifecycle'
import { createServerServices } from '../composition-root'
import { DocumentInUse } from '../documents/errors'
import { InvalidPu66Lifecycle } from '../pu66/errors'
import { SCHEMA_VERSION, readSchemaVersion } from '../database/schema-version'
import { documentMeta, documentFile } from './normative-document-fixture'
import { catalogEntry, catalogSource } from './sign-catalog-fixture'
import { readCard, readEntry } from './pu66-read-fixture'

const connections: DatabaseSync[] = []
const now = () => '2030-02-01T12:00:00.000Z'
afterEach(() => {
  for (const db of connections.splice(0)) db.close()
})
function setup() {
  const services = createServerServices(':memory:', now)
  connections.push(services.db)
  return services
}

describe('server composition without RegistryStore', () => {
  it('shares sources between projects and recovery on the initialized connection', () => {
    const { db, migration, legacy, projects, recovery } = setup()
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION)
    expect(migration).toEqual({ migratedFrom: null, migrationBackup: null })
    expect(legacy.listNormative()).toHaveLength(4)
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    const scheme = importSchemeJson(readFileSync('tests/fixtures/manual-v1.json', 'utf8')).scheme
    const project = projects.save(scheme, 0)
    const sessionId = randomUUID(),
      ownerId = randomUUID()
    recovery.save({
      ownerId,
      input: {
        sessionId,
        scheme,
        expectedVersion: 0,
        baseRevision: project.revision,
        detailsDraft: createSchemeDetailsDraft(scheme),
        placementDraft: null,
        fileName: 'fictional.json',
      },
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_sources').get()).toEqual({ count: 1 })
    recovery.delete({ sessionId, ownerId, expectedVersion: 1 })
    expect(projects.get(scheme.id)?.scheme).toEqual(scheme)
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_sources').get()).toEqual({ count: 1 })
  })

  it('wires import, lifecycle and verification to the same PU-66 state', () => {
    const { pu66Imports, pu66, pu66LifecycleService, pu66Lifecycle, pu66Verifications } = setup()
    const entry = readEntry(readCard())
    pu66Imports.record([entry])
    expect(pu66.list()).toHaveLength(1)
    const input: Pu66LifecycleWrite = {
      action: 'exclude',
      keys: [entry.card.key],
      date: '2030-01-30',
      actor: 'Учебный специалист',
      reason: 'closed',
      comment: '',
      successorKey: null,
    }
    pu66LifecycleService.record(input, pu66LifecycleService.plan(input).fingerprint)
    expect(pu66Lifecycle.getStatus(entry.card.key)?.excluded).toBe(true)
    expect(pu66Imports.inspect([entry])[0]?.status?.excluded).toBe(true)
    expect(() =>
      pu66Verifications.record(entry.card.key, {
        expectedRevision: 1,
        verifiedAt: '2030-01-30',
        verifiedBy: 'Учебный специалист',
      }),
    ).toThrow(InvalidPu66Lifecycle)
    pu66Imports.record([entry], {
      keys: [entry.card.key],
      date: '2030-01-31',
      actor: 'Учебный специалист',
    })
    expect(pu66Lifecycle.getStatus(entry.card.key)?.excluded).toBe(false)
    expect(
      pu66Verifications.record(entry.card.key, {
        expectedRevision: 1,
        verifiedAt: '2030-01-30',
        verifiedBy: 'Учебный специалист',
      })?.cardRevision,
    ).toBe(1)
  })

  it('shares historical sign references with document guards and the atomic delete command', () => {
    const { db, documentService, documents, documentText, signCatalog, deleteDocumentCommand } =
      setup()
    const file = documentFile()
    const document = documentService.add(documentMeta(), file.filename, file.pdf, file.sha256)
    documentText.save(document.id, ['Fictional extracted text'])
    signCatalog.import([catalogEntry()], catalogSource({ documentId: document.id }))
    signCatalog.import([])
    expect(() => documentService.update(document.id, documentMeta({ kind: 'other' }))).toThrow(
      DocumentInUse,
    )
    expect(() => deleteDocumentCommand.execute(document.id)).toThrow(DocumentInUse)
    expect(documentText.get(document.id)).toEqual(['Fictional extracted text'])
    expect(documents.get(document.id)).not.toBeNull()
    const secondFile = documentFile('Another fictional document')
    const second = documentService.add(
      documentMeta(),
      secondFile.filename,
      secondFile.pdf,
      secondFile.sha256,
    )
    documentText.save(second.id, ['Another fictional text'])
    expect(deleteDocumentCommand.execute(second.id)).toBe(true)
    expect(documents.get(second.id)).toBeNull()
    expect(documentText.get(second.id)).toBeNull()
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
})
