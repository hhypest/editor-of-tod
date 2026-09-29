import { schemeSchema, type Scheme } from './model'
import { drawableWithoutImage, signImageCode } from './sheet-drawing'

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
  // Код проекта «3.24_50» показывается изображением «3.24»; закрепляется то, что на листе.
  const images = [
    ...new Set(codes.map((code) => signImageCode(code, new Set(Object.keys(revisions))))),
  ]
  // Скорость 3.24 и расстояние 8.1.1 без PNG программа рисует сама: закреплять нечего.
  const missing = images.filter((code) => !revisions[code] && !drawableWithoutImage(code))
  if (missing.length) {
    throw new Error(`Нужны PNG в локальном каталоге: ${missing.join(', ')}.`)
  }
  return schemeSchema.parse({
    ...scheme,
    signImages: {
      catalog: { id: catalog.id, documentCode: catalog.documentCode, edition: catalog.edition },
      revisions: Object.fromEntries(
        images.filter((code) => revisions[code]).map((code) => [code, revisions[code]]),
      ),
    },
  })
}
