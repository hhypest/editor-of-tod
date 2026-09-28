import { schemeSchema, type Scheme } from './model'

export function usedSignCodes(scheme: Scheme): string[] {
  const codes = scheme.placements.flatMap((placement) =>
    placement.kind === 'sign-post'
      ? placement.signIds
      : placement.elementKind === 'car'
        ? ['4.2.2']
        : placement.elementKind === 'complex'
          ? ['1.25', '4.2.2']
          : [],
  )
  return [...new Set(codes)]
}

export function clearPinsAfterSignChange(previous: Scheme, edited: Scheme): Scheme {
  if (!previous.signImages.catalog) return edited
  const before = usedSignCodes(previous).sort()
  const after = usedSignCodes(edited).sort()
  if (before.length === after.length && before.every((code, index) => code === after[index])) {
    return edited
  }
  return { ...edited, signImages: { catalog: null, revisions: {} } }
}

export function pinSignImages(
  scheme: Scheme,
  catalog: { id: number; documentCode: string; edition: string },
  available: Array<{ code: string; revision: number }>,
): Scheme {
  const codes = usedSignCodes(scheme)
  if (!codes.length) throw new Error('На схеме пока нет знаков для закрепления.')
  const revisions = Object.fromEntries(available.map(({ code, revision }) => [code, revision]))
  const missing = codes.filter((code) => !revisions[code])
  if (missing.length) {
    throw new Error(`Нужны PNG в локальном каталоге: ${missing.join(', ')}.`)
  }
  return schemeSchema.parse({
    ...scheme,
    signImages: {
      catalog: { id: catalog.id, documentCode: catalog.documentCode, edition: catalog.edition },
      revisions: Object.fromEntries(codes.map((code) => [code, revisions[code]])),
    },
  })
}
