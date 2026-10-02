import type { Scheme } from './model'

/**
 * Ошибки целостности, которые нельзя принять отметкой составителя. Пустые текстовые
 * реквизиты здесь не блокируются: их допускается заполнить от руки на бумажном листе.
 * Черновик с этими ошибками остаётся доступен для сверки.
 */
export function releaseProblems(scheme: Scheme): string[] {
  const problems: string[] = []
  if (!scheme.placements.length) problems.push('На листе нет объектов схемы.')
  if (scheme.parameters.location === 'auto')
    problems.push('Укажите, находится ли место работ в населённом пункте.')
  if (scheme.parameters.signSize === 'auto') problems.push('Выберите типоразмер знаков на этапе 2.')
  const distances = scheme.parameters.signDistancesMetres
  for (const placement of scheme.placements) {
    if (placement.kind !== 'sign-post') continue
    const unresolved = (placement.distanceLabel?.match(/\{[^{}]*\}/g) ?? []).filter((marker) => {
      const key = marker.slice(1, -1)
      return !Object.hasOwn(distances, key) || distances[key as keyof typeof distances] === null
    })
    if (unresolved.length)
      problems.push(`Стойка № ${placement.id}: не заполнено расстояние ${unresolved.join(', ')}.`)
  }
  return problems
}
