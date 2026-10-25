import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { extractPu66Cells, type Pu66Card, type Pu66Import } from '../pu66'

export const PRIVATE_MARKER = 'FICTIONAL-PRIVATE-MARKER'
export function readCard(key = '99999:88:3'): Pu66Card {
  const values = new Map<string, string | number>([
    ['A5', 'Карточка № 99'],
    ['A9', 88],
    ['D9', 3],
    ['H9', 'Учебный участок (99999)'],
    ['H17', 'Вымышленная дорога'],
    ['A45', '№ п/п'],
  ])
  for (let item = 1; item <= 30; item++) {
    values.set(`A${47 + item}`, item)
    values.set(`B${47 + item}`, `Учебное поле ${item}`)
    values.set(`E${47 + item}`, 'Вымышленное основание')
    values.set(`J${47 + item}`, item)
    values.set(`L${47 + item}`, item + 1)
  }
  return {
    ...extractPu66Cells((address) => values.get(address) ?? null),
    key,
    division: PRIVATE_MARKER,
    crossingOwner: PRIVATE_MARKER,
    attendant: PRIVATE_MARKER,
    roadCategory: 'II',
    carCountPerDay: 800,
    trainCountPerDay: 40,
    trainVisibilityMetres: { rightOdd: 101, rightEven: 102, leftOdd: 103, leftEven: 104 },
    years: { previous: '2029', current: '2030' },
  }
}
export function readEntry(card: Pu66Card, marker = 'original'): Pu66Import {
  const source = Buffer.from(`${PRIVATE_MARKER}:${card.key}:${marker}`)
  return {
    card,
    source,
    sha256: createHash('sha256').update(source).digest('hex'),
    filename: 'fictional-pu66.xlsx',
  }
}
/** Seed a coherent synthetic persisted state without using RegistryStore/import services. */
export function seedReadCard(db: DatabaseSync, card: Pu66Card, revision = 1) {
  const entry = readEntry(card, `revision-${revision}`),
    updatedAt = '2030-02-01T00:00:00.000Z'
  db.prepare('INSERT OR IGNORE INTO pu66_sources VALUES (?, ?, ?)').run(
    entry.sha256,
    entry.filename,
    entry.source,
  )
  db.prepare(
    `INSERT INTO pu66_cards VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET
    revision = excluded.revision, payload_json = excluded.payload_json, source_sha256 = excluded.source_sha256, updated_at = excluded.updated_at`,
  ).run(card.key, revision, JSON.stringify(card), entry.sha256, updatedAt)
  db.prepare('INSERT INTO pu66_revisions VALUES (?, ?, ?, ?, ?)').run(
    card.key,
    revision,
    JSON.stringify(card),
    entry.sha256,
    updatedAt,
  )
}
