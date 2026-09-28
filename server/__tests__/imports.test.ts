import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zipSync } from 'fflate'
import { PNG } from 'pngjs'
import { describe, expect, it } from 'vitest'
import { createNewScheme } from '../../src/domain/create-scheme'
import { linkPu66Card } from '../../src/domain/link-pu66'
import { annualPu66ReviewStatus } from '../../src/domain/pu66-review'
import { extractPu66Cells, schemeFields, type Pu66Import } from '../pu66'
import { parseSignArchive } from '../signs'
import { RegistryStore } from '../store'

function sampleCard(cardRow: number) {
  const values = new Map<string, string | number>()
  const header = cardRow + 40
  values.set(`A${cardRow}`, 'Карточка № 99')
  values.set(`A${cardRow + 4}`, 88)
  values.set(`D${cardRow + 4}`, 3)
  values.set(`H${cardRow + 4}`, 'Учебный участок (99999)')
  values.set(`H${cardRow + 12}`, 'Условная дорога')
  values.set(`H${cardRow + 25}`, 2)
  values.set(`H${cardRow + 26}`, 500)
  values.set(`A${header}`, '№ п/п')
  values.set(`J${header + 2}`, 2025)
  values.set(`L${header + 2}`, 2026)
  for (let index = 1; index <= 30; index++) {
    const row = header + 2 + index
    values.set(`A${row}`, index)
    values.set(`B${row}`, `Учебное поле ${index}`)
    values.set(`E${row}`, 'Учебное правило')
    values.set(`J${row}`, index)
    values.set(`L${row}`, index + 1)
  }
  return extractPu66Cells((address) => values.get(address) ?? null)
}

function signZip(code = '1.1_ж', color = 210) {
  const image = new PNG({ width: 30, height: 30 })
  image.data.fill(255)
  for (let y = 8; y < 22; y++) {
    for (let x = 8; x < 22; x++) {
      const offset = (y * 30 + x) * 4
      image.data[offset] = color
      image.data[offset + 1] = 0
      image.data[offset + 2] = 0
    }
  }
  const png = PNG.sync.write(image)
  return Buffer.from(
    zipSync({
      [`PNG с номером/${code}.png`]: png,
      [`PNG без номера/${code}.png`]: png,
    }),
  )
}

describe('private import formats', () => {
  it('uses the latest actual review date after a historical entry is backfilled', () => {
    const store = new RegistryStore(':memory:', () => '2027-02-01T12:00:00.000Z')
    try {
      const card = sampleCard(5)
      const source = Buffer.from('synthetic workbook')
      store.importPu66([
        {
          card,
          source,
          sha256: createHash('sha256').update(source).digest('hex'),
          filename: 'TEST-99.xlsx',
        },
      ])
      store.recordPu66Verification(card.key, {
        expectedRevision: 1,
        verifiedAt: '2027-01-30',
        verifiedBy: 'Учебное подразделение А',
      })
      store.recordPu66Verification(card.key, {
        expectedRevision: 1,
        verifiedAt: '2026-01-30',
        verifiedBy: 'Учебное подразделение Б',
      })
      const latest = store.listPu66()[0]?.verification
      expect(latest).toMatchObject({ verifiedAt: '2027-01-30' })
      expect(annualPu66ReviewStatus(latest?.verifiedAt ?? null, '2027-02-01')).toMatchObject({
        kind: 'current',
        nextDue: '2028-01-30',
      })
      expect(store.listPu66Verifications(card.key)?.map((record) => record.verifiedAt)).toEqual([
        '2026-01-30',
        '2027-01-30',
      ])
      store.recordPu66Verification(card.key, {
        expectedRevision: 1,
        verifiedAt: '2027-01-30',
        verifiedBy: 'Учебное подразделение В',
      })
      expect(store.listPu66()[0]?.verification?.verifiedBy).toBe('Учебное подразделение В')
    } finally {
      store.close()
    }
  })

  it('reads both observed row offsets and exposes only fields selected for a scheme', () => {
    for (const cardRow of [4, 5]) {
      const card = sampleCard(cardRow)
      expect(card.key).toBe('99999:88:3')
      expect(card.technicalRows).toHaveLength(30)
      const subset = schemeFields(card)
      expect(subset).toMatchObject({ location: '88 км 3 пк', crossingWidthMetres: 8 })
      expect(subset).not.toHaveProperty('technicalRows')
      expect(subset).not.toHaveProperty('division')
      expect(subset).not.toHaveProperty('carCountPerDay')
      expect(schemeFields({ ...card, roadName: '0' }).roadName).toBe('')
    }
  })

  it('imports a card with original workbook bytes, keeps revisions, and skips repeated input', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-private-import-'))
    const path = join(directory, 'registry.sqlite')
    try {
      const store = new RegistryStore(path, () => '2026-09-27T12:00:00.000Z')
      const source = Buffer.from('synthetic workbook bytes')
      const card = sampleCard(5)
      const entry: Pu66Import = {
        card,
        source,
        sha256: createHash('sha256').update(source).digest('hex'),
        filename: 'TEST-99.xlsx',
      }
      expect(() => store.planPu66([entry, entry])).toThrow('Повторный ключ')
      expect(store.importPu66([entry])).toEqual({ added: 1, updated: 0, unchanged: 0 })
      expect(store.importPu66([entry])).toEqual({ added: 0, updated: 0, unchanged: 1 })
      expect(store.listPu66()).toMatchObject([{ referenceId: '99999:88:3', revision: 1 }])
      expect(store.listPu66()[0]?.verification).toBeNull()
      expect(() =>
        store.recordPu66Verification(card.key, {
          expectedRevision: 1,
          verifiedAt: '2027-01-30',
          verifiedBy: 'Учебное линейное подразделение',
        }),
      ).toThrow('не может быть в будущем')
      expect(
        store.recordPu66Verification(card.key, {
          expectedRevision: 1,
          verifiedAt: '2026-01-30',
          verifiedBy: 'Учебное линейное подразделение',
        }),
      ).toMatchObject({ cardRevision: 1, verifiedAt: '2026-01-30' })
      expect(store.listPu66()[0]?.verification).toMatchObject({
        verifiedBy: 'Учебное линейное подразделение',
      })
      expect(() =>
        store.recordPu66Verification(card.key, {
          expectedRevision: 2,
          verifiedAt: '2026-01-30',
          verifiedBy: 'Учебное линейное подразделение',
        }),
      ).toThrow('Запись изменилась')
      expect(store.getPu66Scheme(card.key)).toMatchObject({
        ...schemeFields(card),
        revision: 1,
        updatedAt: expect.any(String),
      })
      const native = createNewScheme({
        referenceId: 'TEST-NEW',
        locationText: '',
        directionLeft: '',
        directionRight: '',
        frontMetres: '18',
        taperMetres: '8',
        bufferMetres: '10',
        speedStagesKmh: ['70', '50', '40'],
        yellowTemporarySigns: false,
      })
      const selected = store.getPu66Scheme(card.key)
      if (!selected) throw new Error('Synthetic card missing')
      store.saveProject(linkPu66Card(native, selected), 0)
      const newSource = Buffer.from('synthetic workbook revision')
      const next = {
        ...entry,
        card: { ...card, roadName: 'Обновлённая вымышленная дорога' },
        source: newSource,
        sha256: createHash('sha256').update(newSource).digest('hex'),
      }
      expect(store.importPu66([next])).toEqual({ added: 0, updated: 1, unchanged: 0 })
      const newer = store.getPu66Scheme(card.key)
      expect(newer?.revision).toBe(2)
      expect(store.listPu66()[0]?.verification).toBeNull()
      expect(store.listPu66Verifications(card.key)).toMatchObject([
        { cardRevision: 1, verifiedAt: '2026-01-30' },
      ])
      expect(newer?.roadName).toBe('Обновлённая вымышленная дорога')
      expect(newer).not.toHaveProperty('technicalRows')
      expect(newer).not.toHaveProperty('carCountPerDay')
      const saved = store.getProject(native.id)
      expect(saved?.scheme.crossing.snapshot?.revision).toBe(1)
      expect(saved?.scheme.crossing.snapshot?.roadName).toBe(selected.roadName)
      expect(saved?.revision).toBe(1)
      store.recordPu66Verification(card.key, {
        expectedRevision: 2,
        verifiedAt: '2026-09-27',
        verifiedBy: 'Учебное линейное подразделение',
      })
      expect(store.listPu66Verifications(card.key)).toMatchObject([
        { cardRevision: 2, verifiedAt: '2026-09-27' },
        { cardRevision: 1, verifiedAt: '2026-01-30' },
      ])
      store.close()
      const database = new DatabaseSync(path)
      expect(database.prepare('SELECT COUNT(*) AS total FROM pu66_revisions').get()).toMatchObject({
        total: 2,
      })
      expect(database.prepare('SELECT COUNT(*) AS total FROM pu66_sources').get()).toMatchObject({
        total: 2,
      })
      expect(
        database.prepare('SELECT COUNT(*) AS total FROM pu66_verifications').get(),
      ).toMatchObject({ total: 2 })
      const sourceRow = database
        .prepare('SELECT workbook FROM pu66_sources WHERE sha256 = ?')
        .get(entry.sha256) as { workbook: Uint8Array }
      expect(Buffer.from(sourceRow.workbook)).toEqual(source)
      database.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('upgrades a version 4 database and preserves imported cards', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-v4-verification-'))
    const path = join(directory, 'registry.sqlite')
    try {
      const original = new RegistryStore(path)
      const card = sampleCard(5)
      original.importPu66([
        {
          card,
          source: Buffer.from('synthetic workbook'),
          sha256: 'b'.repeat(64),
          filename: 'TEST-99.xlsx',
        },
      ])
      original.close()
      const old = new DatabaseSync(path)
      old.exec(
        'DROP TABLE project_sources; DROP TABLE pu66_verifications; PRAGMA user_version = 4;',
      )
      old.close()
      const migrated = new RegistryStore(path)
      expect(migrated.listPu66()).toMatchObject([{ referenceId: card.key, revision: 1 }])
      expect(migrated.listPu66()[0]?.verification).toBeNull()
      migrated.close()
      const current = new DatabaseSync(path)
      expect(current.prepare('PRAGMA user_version').get()).toEqual({ user_version: 7 })
      current.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('loads both PNG sign variants without generating vector data', () => {
    const source = signZip()
    const entries = parseSignArchive(source)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.code).toBe('1.1_ж')
    expect(entries[0]).not.toHaveProperty('plainSvg')
    const store = new RegistryStore(':memory:')
    try {
      expect(store.importSigns(entries)).toMatchObject({ added: 1 })
      expect(store.importSigns(parseSignArchive(source))).toMatchObject({ unchanged: 1 })
      expect(store.listSigns()).toEqual([{ code: '1.1_ж', width: 30, height: 30, revision: 1 }])
      expect(Buffer.from(store.getSignPng('1.1_ж', true) as Uint8Array)).toEqual(
        entries[0]?.numberedPng,
      )
      expect(Buffer.from(store.getSignPng('1.1_ж', false) as Uint8Array)).toEqual(
        entries[0]?.plainPng,
      )
    } finally {
      store.close()
    }
  })

  it('replaces the active archive, records its edition, and retains prior PNG revisions locally', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-sign-history-'))
    const path = join(directory, 'registry.sqlite')
    try {
      const first = parseSignArchive(signZip('1.25', 210))
      const second = parseSignArchive(signZip('3.20', 190))
      const source = { documentCode: 'ГОСТ Р TEST', edition: '2024', pdfSha256: null }
      const updated = { ...source, edition: '2026' }
      const store = new RegistryStore(path)
      expect(store.importSigns(first, source)).toMatchObject({ added: 1 })
      expect(store.latestSignCatalog()).toMatchObject({ edition: '2024', signCount: 1 })
      expect(store.importSigns(first, source)).toMatchObject({ unchanged: 1 })
      expect(store.planSigns(first, updated)).toMatchObject({ updated: 1 })
      expect(store.importSigns(first, updated)).toMatchObject({ updated: 1 })
      expect(store.latestSignCatalog()).toMatchObject({ edition: '2026' })
      expect(store.importSigns(second, updated)).toMatchObject({ added: 1, retired: 1 })
      expect(store.listSigns()).toEqual([{ code: '3.20', width: 30, height: 30, revision: 1 }])
      expect(store.getSignPng('1.25', false)).toBeNull()
      expect(store.importSigns(first, updated)).toMatchObject({ added: 1, retired: 1 })
      expect(Buffer.from(store.getSignPng('1.25', false) as Uint8Array)).toEqual(first[0]?.plainPng)
      expect(Buffer.from(store.getSignPng('1.25', false, 1) as Uint8Array)).toEqual(
        first[0]?.plainPng,
      )
      store.close()
      const database = new DatabaseSync(path)
      expect(database.prepare('SELECT COUNT(*) AS total FROM sign_catalog_batches').get()).toEqual({
        total: 4,
      })
      expect(
        database
          .prepare('SELECT revision, active FROM sign_revisions WHERE code = ? ORDER BY revision')
          .all('1.25'),
      ).toEqual([
        { revision: 1, active: 1 },
        { revision: 2, active: 0 },
        { revision: 3, active: 1 },
      ])
      database.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('upgrades a version 1 local database without losing its manual crossing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-v1-upgrade-'))
    const path = join(directory, 'registry.sqlite')
    try {
      const old = new DatabaseSync(path)
      old.exec(`
        CREATE TABLE crossings (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE normative (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE revisions (kind TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(kind,key,revision));
        PRAGMA user_version = 1;
      `)
      const payload = {
        referenceId: 'TEST-001',
        railwayLocation: '',
        roadName: '',
        roadOwner: '',
        cardReference: '',
        cardUpdatedAt: '',
        verifiedAt: '',
        notes: '',
      }
      old
        .prepare('INSERT INTO crossings VALUES (?, ?, ?, ?)')
        .run('TEST-001', 1, JSON.stringify(payload), '2026-09-26T00:00:00Z')
      old.close()
      const migrated = new RegistryStore(path)
      expect(migrated.listCrossings()).toMatchObject([{ referenceId: 'TEST-001', revision: 1 }])
      expect(migrated.listPu66()).toEqual([])
      migrated.close()
      expect(readFileSync(path).subarray(0, 16).toString()).toBe('SQLite format 3\u0000')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('upgrades a version 2 database and removes stored SVG bytes while preserving the PNGs', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-v2-upgrade-'))
    const path = join(directory, 'registry.sqlite')
    const marker = '<svg id="synthetic-obsolete-sign">'
    try {
      const source = signZip()
      const entry = parseSignArchive(source)[0]!
      const store = new RegistryStore(path)
      store.importSigns([entry])
      store.close()
      const old = new DatabaseSync(path)
      old.exec(`
        DROP TABLE project_sources;
        DROP TABLE pu66_verifications;
        DROP TABLE project_revisions;
        DROP TABLE project_drafts;
        ALTER TABLE signs ADD COLUMN plain_svg TEXT;
        PRAGMA user_version = 2;
      `)
      old.prepare('UPDATE signs SET plain_svg = ? WHERE code = ?').run(marker, entry.code)
      old.close()

      const migrated = new RegistryStore(path)
      expect(migrated.listSigns()).toEqual([
        { code: entry.code, width: 30, height: 30, revision: 1 },
      ])
      expect(Buffer.from(migrated.getSignPng(entry.code, true) as Uint8Array)).toEqual(
        entry.numberedPng,
      )
      expect(Buffer.from(migrated.getSignPng(entry.code, false) as Uint8Array)).toEqual(
        entry.plainPng,
      )
      expect(migrated.planSigns([entry])).toMatchObject({ unchanged: 1 })
      migrated.close()

      const database = new DatabaseSync(path)
      expect(database.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 7 })
      expect(
        (database.prepare('PRAGMA table_info(signs)').all() as { name: string }[]).map(
          (column) => column.name,
        ),
      ).not.toContain('plain_svg')
      expect(database.prepare('PRAGMA integrity_check').get()).toMatchObject({
        integrity_check: 'ok',
      })
      database.close()
      expect(readFileSync(path).includes(Buffer.from(marker))).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
