import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zipSync } from 'fflate'
import { PNG } from 'pngjs'
import { describe, expect, it } from 'vitest'
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

function signZip() {
  const image = new PNG({ width: 30, height: 30 })
  image.data.fill(255)
  for (let y = 8; y < 22; y++) {
    for (let x = 8; x < 22; x++) {
      const offset = (y * 30 + x) * 4
      image.data[offset] = 210
      image.data[offset + 1] = 0
      image.data[offset + 2] = 0
    }
  }
  const png = PNG.sync.write(image)
  return Buffer.from(
    zipSync({
      'PNG с номером/1.1_ж.png': png,
      'PNG без номера/1.1_ж.png': png,
    }),
  )
}

describe('private import formats', () => {
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
      const store = new RegistryStore(path)
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
      const newSource = Buffer.from('synthetic workbook revision')
      const next = {
        ...entry,
        source: newSource,
        sha256: createHash('sha256').update(newSource).digest('hex'),
      }
      expect(store.importPu66([next])).toEqual({ added: 0, updated: 1, unchanged: 0 })
      store.close()
      const database = new DatabaseSync(path)
      expect(database.prepare('SELECT COUNT(*) AS total FROM pu66_revisions').get()).toMatchObject({
        total: 2,
      })
      expect(database.prepare('SELECT COUNT(*) AS total FROM pu66_sources').get()).toMatchObject({
        total: 2,
      })
      const sourceRow = database
        .prepare('SELECT workbook FROM pu66_sources WHERE sha256 = ?')
        .get(entry.sha256) as { workbook: Uint8Array }
      expect(Buffer.from(sourceRow.workbook)).toEqual(source)
      database.close()
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
      expect(store.listSigns()).toEqual([{ code: '1.1_ж', width: 30, height: 30 }])
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
        DROP TABLE project_revisions;
        DROP TABLE project_drafts;
        ALTER TABLE signs ADD COLUMN plain_svg TEXT;
        PRAGMA user_version = 2;
      `)
      old.prepare('UPDATE signs SET plain_svg = ? WHERE code = ?').run(marker, entry.code)
      old.close()

      const migrated = new RegistryStore(path)
      expect(migrated.listSigns()).toEqual([{ code: entry.code, width: 30, height: 30 }])
      expect(Buffer.from(migrated.getSignPng(entry.code, true) as Uint8Array)).toEqual(
        entry.numberedPng,
      )
      expect(Buffer.from(migrated.getSignPng(entry.code, false) as Uint8Array)).toEqual(
        entry.plainPng,
      )
      expect(migrated.planSigns([entry])).toMatchObject({ unchanged: 1 })
      migrated.close()

      const database = new DatabaseSync(path)
      expect(database.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 4 })
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
