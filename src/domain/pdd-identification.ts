import { z } from 'zod'

/** Дата явно обозначенной редакции; дата исходного постановления не является редакцией. */
export function pddEdition(text: string): string {
  const date = /(?:ред\.|редакция)\s*(?:от\s*)?(\d{2})\.(\d{2})\.((?:19|20)\d{2})/iu.exec(text)
  const iso = date ? `${date[3]}-${date[2]}-${date[1]}` : ''
  return z.iso.date().safeParse(iso).success ? iso : ''
}

/** Только заголовок основного документа: упоминание № 1090 в изменяющем акте не подходит. */
export function isPddHeading(text: string): boolean {
  const header = text.slice(0, 3_000).replace(/\s+/g, ' ')
  return (
    /постановлени[ея]/iu.test(header) &&
    /(?:23\.10\.1993|23\s+октября\s+1993)/iu.test(header) &&
    /(?:№|N)\s*1090(?!\d)/iu.test(header) &&
    /о\s+правилах\s+дорожного\s+движения/iu.test(header) &&
    !/(?:нормативные ссылки|библиография)/iu.test(header) &&
    !/о\s+внесении\s+изменени/iu.test(header)
  )
}
