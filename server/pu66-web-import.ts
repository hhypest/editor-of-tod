import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parsePu66, type Pu66Import } from './pu66.ts'
import { RegistryStore, RevisionConflict } from './store.ts'

const MAX_WORKBOOK_BYTES = 4 * 1024 * 1024
const MAX_FILES = 4
export const PU66_UPLOAD_REQUEST_BYTES = 24 * 1024 * 1024

const fileSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(240)
    .regex(/\.xlsx$/i),
  data: z.string().min(1),
})
const filesSchema = z.array(fileSchema).min(1).max(MAX_FILES)
const previewSchema = z.strictObject({ files: filesSchema })
const applySchema = z.strictObject({
  files: filesSchema,
  expectedFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
})

export class InvalidPu66Upload extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

async function parseFiles(files: z.infer<typeof filesSchema>): Promise<Pu66Import[]> {
  const entries: Pu66Import[] = []
  for (const [index, file] of files.entries()) {
    if (file.data.length > Math.ceil(MAX_WORKBOOK_BYTES / 3) * 4) {
      throw new InvalidPu66Upload('Каждая книга ПУ-66 должна быть не больше 4 МБ.', 413)
    }
    const source = Buffer.from(file.data, 'base64')
    if (source.length > MAX_WORKBOOK_BYTES) {
      throw new InvalidPu66Upload('Каждая книга ПУ-66 должна быть не больше 4 МБ.', 413)
    }
    if (source.toString('base64') !== file.data) {
      throw new InvalidPu66Upload(`Книга № ${index + 1}: неверные данные файла.`)
    }
    try {
      entries.push(await parsePu66(source, file.name))
    } catch (error) {
      const message =
        error instanceof Error && error.message.startsWith('ПУ-66:')
          ? error.message
          : 'файл повреждён или форма не распознана.'
      throw new InvalidPu66Upload(`Книга № ${index + 1}: ${message}`)
    }
  }
  return entries
}

function planImport(store: RegistryStore, entries: Pu66Import[]) {
  let items: ReturnType<RegistryStore['inspectPu66']>
  try {
    items = store.inspectPu66(entries)
  } catch (error) {
    throw new InvalidPu66Upload(error instanceof Error ? error.message : 'Повторный ключ ПУ-66.')
  }
  const counts = { added: 0, updated: 0, unchanged: 0 }
  for (const item of items) {
    if (item.action === 'add') counts.added++
    else if (item.action === 'update') counts.updated++
    else counts.unchanged++
  }
  const fingerprint = createHash('sha256').update(JSON.stringify(items)).digest('hex')
  return {
    ...counts,
    fingerprint,
    items: items.map(({ filename, referenceId, location, roadName, action, currentRevision }) => ({
      filename,
      referenceId,
      location,
      roadName,
      action,
      currentRevision,
    })),
  }
}

export async function previewPu66Upload(store: RegistryStore, body: unknown) {
  const { files } = previewSchema.parse(body)
  return planImport(store, await parseFiles(files))
}

export async function applyPu66Upload(store: RegistryStore, body: unknown) {
  const { files, expectedFingerprint } = applySchema.parse(body)
  const entries = await parseFiles(files)
  const planned = planImport(store, entries)
  if (planned.fingerprint !== expectedFingerprint) throw new RevisionConflict()
  if (planned.added + planned.updated === 0) {
    return { added: 0, updated: 0, unchanged: planned.unchanged, backup: null }
  }
  const backup = await store.createBackup()
  if (planImport(store, entries).fingerprint !== expectedFingerprint) throw new RevisionConflict()
  return { ...store.importPu66(entries), backup }
}
