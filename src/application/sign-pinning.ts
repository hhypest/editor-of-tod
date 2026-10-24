import type { Scheme } from '../domain/model'
import { pinSignImages } from '../domain/sign-images'

export interface SignCatalogSnapshot {
  catalog: { id: number; documentCode: string; edition: string } | null
  signs: Array<{ code: string; revision: number }>
}

export interface SignCatalogRepository {
  loadCatalog(): Promise<SignCatalogSnapshot>
}

/** Reads through a port and rejects a delivery to a different document snapshot. */
export async function PinProjectSigns(
  scheme: Scheme,
  repository: SignCatalogRepository,
  currentScheme: () => Scheme | null,
): Promise<Scheme> {
  const { signs, catalog } = await repository.loadCatalog()
  if (!Array.isArray(signs) || !catalog || catalog.edition === 'не указана')
    throw new Error('Укажите версию ГОСТ при импорте каталога знаков.')
  if (currentScheme() !== scheme) throw new Error('Проект изменился; повторите закрепление.')
  return pinSignImages(scheme, catalog, signs)
}
