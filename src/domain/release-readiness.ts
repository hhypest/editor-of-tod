import type { Scheme } from './model'
import { distanceTitles } from './normative-defaults'
import type { SheetNode } from './sheet-drawing'

/**
 * Ошибки целостности, которые нельзя принять отметкой составителя. Пустые текстовые
 * реквизиты здесь не блокируются: их допускается заполнить от руки на бумажном листе.
 * Черновик с этими ошибками остаётся доступен для сверки.
 *
 * `nodes` — нарисованный лист: по его надписям дополнительно ищутся незаполненные
 * подстановки вида `{d150}`, попавшие в текст помимо подписей стоек.
 */
export function releaseProblems(scheme: Scheme, nodes: readonly SheetNode[] = []): string[] {
  const problems: string[] = []
  if (!scheme.placements.length) problems.push('На листе нет объектов схемы.')
  if (scheme.parameters.location === 'auto')
    problems.push('Укажите, находится ли место работ в населённом пункте.')
  if (scheme.parameters.signSize === 'auto') problems.push('Выберите типоразмер знаков на этапе 2.')
  // Условия работ печатаются в примечаниях листа: незаполненное значение дало бы там
  // «уточнить» вместо сведений о работах.
  const { workConditions: conditions, regulation } = scheme.parameters
  if (conditions.kind === 'unknown')
    problems.push('Укажите на этапе 2, краткосрочные работы или долгосрочные.')
  else if (conditions.durationHours === null)
    problems.push('Укажите на этапе 2 продолжительность работ в часах.')
  if (conditions.daylight === 'unknown')
    problems.push('Укажите на этапе 2, выполняются ли работы только в светлое время суток.')
  const b34 = scheme.template.code === 'b34'
  if (b34 && regulation.mode === 'auto')
    problems.push('Выберите на этапе 2 способ пропуска транспорта: он указывается в заголовке.')
  if (
    (!b34 || regulation.mode === 'one' || regulation.mode === 'two') &&
    !conditions.regulatorsPresent
  )
    problems.push(
      'Подтвердите на этапе 2 постоянное присутствие регулировщиков в течение всего срока работ.',
    )
  const distances = scheme.parameters.signDistancesMetres
  const reported = new Set<string>()
  for (const placement of scheme.placements) {
    if (placement.kind !== 'sign-post') continue
    if (placement.distance?.by === 'marker' && distances[placement.distance.marker] === null) {
      const marker = `{${placement.distance.marker}}`
      reported.add(marker)
      problems.push(
        `Стойка № ${placement.id}: не заполнено расстояние «${distanceTitles[placement.distance.marker]}» на этапе 2.`,
      )
    }
    const unresolved = (placement.distanceLabel?.match(/\{[^{}]*\}/g) ?? []).filter((marker) => {
      const key = marker.slice(1, -1)
      return !Object.hasOwn(distances, key) || distances[key as keyof typeof distances] === null
    })
    for (const marker of unresolved) reported.add(marker)
    if (unresolved.length)
      problems.push(`Стойка № ${placement.id}: не заполнено расстояние ${unresolved.join(', ')}.`)
  }
  const stray = new Set<string>()
  for (const node of nodes) {
    if (node.t !== 'text') continue
    for (const marker of node.text.match(/\{[^{}]*\}/g) ?? [])
      if (!reported.has(marker)) stray.add(marker)
  }
  if (stray.size)
    problems.push(
      `В надписях листа осталась незаполненная подстановка ${[...stray].join(', ')}. Замените её значением.`,
    )
  return problems
}
