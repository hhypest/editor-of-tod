import type { Scheme } from './model'
import type { ReviewFinding } from './review-scheme'

/**
 * Отметки «Проверено» у пунктов «Проверить вручную». Отметка хранит отпечаток пункта — его
 * заголовка, текста и проверяемых данных (`basis`). Если после отметки пункт или данные
 * изменились, отметка перестаёт действовать и пункт снова нужно проверить.
 */

export type MarkState =
  | { status: 'unmarked' }
  | { status: 'marked'; markedAt: string }
  /** Отметка есть, но пункт с тех пор изменился. */
  | { status: 'stale'; markedAt: string }
  /** Пункт пока нельзя отметить; причина — в `finding.markBlocked`. */
  | { status: 'blocked'; reason: string }

/** FNV-1a (64 бита): короткий устойчивый отпечаток без асинхронного `crypto.subtle`. */
function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte)
    hash = (hash * prime) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

export function findingFingerprint(finding: ReviewFinding): string {
  return fnv1a64([finding.id, finding.title, finding.detail, finding.basis ?? ''].join('\n'))
}

export function markState(scheme: Scheme, finding: ReviewFinding): MarkState {
  if (finding.markBlocked) return { status: 'blocked', reason: finding.markBlocked }
  const mark = scheme.reviewMarks[finding.id]
  if (!mark) return { status: 'unmarked' }
  return mark.fingerprint === findingFingerprint(finding)
    ? { status: 'marked', markedAt: mark.markedAt }
    : { status: 'stale', markedAt: mark.markedAt }
}

/** Пункты ручной проверки без действующей отметки. */
export function unmarkedChecks(
  scheme: Scheme,
  findings: readonly ReviewFinding[],
): ReviewFinding[] {
  return findings.filter(
    (finding) => finding.kind === 'verify' && markState(scheme, finding).status !== 'marked',
  )
}

/**
 * Ставит или снимает отметку. Отметки пунктов, которых больше нет в списке, удаляются,
 * чтобы проект не копил устаревшие записи.
 */
export function setMark(
  scheme: Scheme,
  findings: readonly ReviewFinding[],
  findingId: string,
  checked: boolean,
  now: string = new Date().toISOString(),
): Scheme {
  const current = new Set(
    findings.filter((finding) => finding.kind === 'verify').map((finding) => finding.id),
  )
  const finding = findings.find((item) => item.id === findingId && item.kind === 'verify')
  if (!finding) throw new Error('Пункт ручной проверки не найден: список обновился.')
  if (checked && finding.markBlocked) throw new Error(finding.markBlocked)
  const marks = Object.fromEntries(
    Object.entries(scheme.reviewMarks).filter(([id]) => current.has(id) && id !== findingId),
  )
  if (checked) marks[findingId] = { fingerprint: findingFingerprint(finding), markedAt: now }
  return { ...scheme, reviewMarks: marks }
}
