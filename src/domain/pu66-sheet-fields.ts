import type { Pu66Snapshot } from './pu66-snapshot'
import { decimalComma } from './number-format'

function show(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === '' ? '—' : decimalComma(String(value))
}

/** One whitelist for comparison and printing. Source labels retain objects and directions. */
export function pu66DisplayRows(
  snapshot: Pu66Snapshot | null,
): Array<{ label: string; value: string }> {
  if (!snapshot) return []
  const rows: Array<{ label: string; value: string }> = []
  if (snapshot.railwayLocation) {
    rows.push(
      { label: 'Участок / перегон по карточке', value: snapshot.railwayLocation.section || '—' },
      { label: 'Станция по карточке', value: snapshot.railwayLocation.station || '—' },
    )
  }
  if (snapshot.visibility) {
    const { train, technical, years } = snapshot.visibility
    for (const [key, direction] of [
      ['rightOdd', 'справа, нечётного направления'],
      ['rightEven', 'справа, чётного направления'],
      ['leftOdd', 'слева, нечётного направления'],
      ['leftEven', 'слева, чётного направления'],
    ] as const)
      rows.push({ label: `Видимость поезда ${direction}, м`, value: show(train[key]) })
    for (const row of technical)
      rows.push({
        label: `ПУ-66, п. ${row.item}: ${row.label}`,
        value: `${years.previous || 'Предыдущий год'}: ${show(row.previous)}; ${years.current || 'текущий год'}: ${show(row.current)}`,
      })
  }
  return rows
}

/** Values from the pinned snapshot only; never read the current registry while printing. */
export function pu66SheetNotes(snapshot: Pu66Snapshot | null): string[] {
  if (!snapshot?.visibility) return []
  const { train, years, technical } = snapshot.visibility
  const result: string[] = []
  if (Object.values(train).some((value) => value !== null && value !== ''))
    result.push(
      `Видимость поезда, м (ПУ-66): справа — нечётного направления ${show(train.rightOdd)}, чётного ${show(train.rightEven)}; слева — нечётного ${show(train.leftOdd)}, чётного ${show(train.leftEven)}.`,
    )
  if (technical.length) {
    result.push(
      `Видимость по технической таблице ПУ-66: ${years.previous || 'предыдущий год'} / ${years.current || 'текущий год'} (значения по порядку).`,
    )
    for (const row of technical)
      result.push(`П. ${row.item}, ${row.label}: ${show(row.previous)} / ${show(row.current)}.`)
  }
  return result
}
