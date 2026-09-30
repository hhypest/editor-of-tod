/**
 * Реквизиты листа формата v6: разбор прежних строк ответственных и маска телефона.
 * Чистые функции без зависимостей — используются при чтении v1–v5 и в форме реквизитов.
 */

export type ResponsiblePerson = { position: string; name: string; phone: string }

/** Маска телефона ответственного: +7 (XXX) XXX-XX-XX. Пустая строка — телефон не указан. */
export const PHONE_PATTERN = /^\+7 \(\d{3}\) \d{3}-\d{2}-\d{2}$/
export const PHONE_PLACEHOLDER = '+7 (___) ___-__-__'

/**
 * Приводит ввод к маске по мере набора: «89101234567», «+7 910 123 45 67» и «9101234567»
 * дают «+7 (910) 123-45-67». Код страны — «+7» в начале либо первая «8» или «7» при вводе
 * без «+7». Скобка и дефисы появляются только перед следующими цифрами, поэтому стирание
 * работает обычным образом. Лишние цифры отбрасываются.
 */
export function formatPhone(input: string): string {
  const raw = input.trim()
  let digits = raw.replace(/\D/g, '')
  if (raw.startsWith('+7')) digits = digits.slice(1)
  else if (/^[78]/.test(digits)) {
    digits = digits.slice(1)
    if (!digits) return '+7 ('
  }
  if (!digits) return ''
  digits = digits.slice(0, 10)
  let result = `+7 (${digits.slice(0, 3)}`
  if (digits.length > 3) result += `) ${digits.slice(3, 6)}`
  if (digits.length > 6) result += `-${digits.slice(6, 8)}`
  if (digits.length > 8) result += `-${digits.slice(8, 10)}`
  return result
}

export function phoneComplete(phone: string): boolean {
  return PHONE_PATTERN.test(phone)
}

const PHONE_IN_TEXT =
  /[,;]?\s*(?:тел(?:ефон)?\.?:?\s*)?(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b/iu
/** ФИО в конце строки: «Фатеев Игорь Леонидович» или «Иванов И.И.» / «Иванов И. И.». */
const NAME_AT_END =
  /(?:^|\s)((?:[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?)(?:\s+[А-ЯЁ][а-яё]+){2}|[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?\s+[А-ЯЁ]\.\s?[А-ЯЁ]\.)\s*$/u

/**
 * Разбирает прежнюю строку ответственного («начальник участка Фатеев Игорь Леонидович,
 * тел. 8 910 123-45-67») на должность, ФИО и телефон. Если ФИО не распознано, вся строка
 * остаётся в поле ФИО — составитель поправит её в форме.
 */
export function splitResponsible(text: string): ResponsiblePerson {
  let rest = text.trim()
  let phone = ''
  const phoneMatch = PHONE_IN_TEXT.exec(rest)
  if (phoneMatch) {
    phone = formatPhone(phoneMatch[0])
    if (!phoneComplete(phone)) phone = ''
    else
      rest = `${rest.slice(0, phoneMatch.index)} ${rest.slice(phoneMatch.index + phoneMatch[0].length)}`
  }
  rest = rest
    .replace(/\s+/g, ' ')
    .replace(/[,;\s]+$/u, '')
    .trim()
  const name = NAME_AT_END.exec(rest)
  if (!name) return { position: '', name: rest, phone }
  const position = rest
    .slice(0, name.index)
    .replace(/[,;\s]+$/u, '')
    .trim()
  return { position, name: name[1]!.trim(), phone }
}

/** Прежняя пара строк v1–v5 → ответственные v6: первый всегда есть, второй — если заполнен. */
export function responsibleFromLegacy(
  first: string,
  second: string,
): [ResponsiblePerson] | [ResponsiblePerson, ResponsiblePerson] {
  const one = splitResponsible(first)
  return second.trim() ? [one, splitResponsible(second)] : [one]
}

/** Строка ответственного на листе: «должность ФИО, тел. +7 (…)». */
export function responsibleLine(person: ResponsiblePerson): string {
  const who = [person.position, person.name]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ')
  return person.phone.trim() ? `${who}, тел. ${person.phone.trim()}` : who
}
