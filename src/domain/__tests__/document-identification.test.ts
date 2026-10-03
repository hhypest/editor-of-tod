import { describe, expect, it } from 'vitest'
import { identifyDocument } from '../document-identification'
import { kindForCode, suggestFromFilename } from '../normative-documents'

describe('document identification proposals', () => {
  it.each([
    ['ГОСТ Р 52290—2024. Знаки.pdf', 'ГОСТ Р 52290', '2024', 'signs'],
    ['ГОСТ_Р_58350-2019.pdf', 'ГОСТ Р 58350', '2019', 'rules'],
    ['ОДМ 218.6.019–2016_1.pdf', 'ОДМ 218.6.019', '2016', 'methodology'],
    ['gost-r-52289-2019.pdf', 'ГОСТ Р 52289', '2019', 'rules'],
  ])('understands Cyrillic and Latin filename %s', (name, code, edition, kind) => {
    expect(suggestFromFilename(name)).toEqual({ code, edition, kind })
    expect(kindForCode(code)).toBe(kind)
  })

  it('uses the title, even with a misleading filename and other standards in the body', () => {
    const result = identifyDocument(
      [
        'НАЦИОНАЛЬНЫЙ СТАНДАРТ\nГОСТ\nР\n90001—2030\nУчебные правила\nСинтетический документ',
        '2 Нормативные ссылки\nГОСТ Р 90002-2029 Учебные определения',
      ],
      'ГОСТ Р 90002-2029.pdf',
    )
    expect(result).toMatchObject({ status: 'identified', filenameConflict: true })
    expect(result.candidates).toEqual([
      expect.objectContaining({
        code: 'ГОСТ Р 90001',
        edition: '2030',
        documentType: 'base',
        page: 1,
        title: 'Учебные правила Синтетический документ',
      }),
    ])
  })

  it('looks past a scanned cover without inventing metadata from the filename', () => {
    expect(
      identifyDocument(['', 'ОДМ 900.1.001-2030\nУчебная методика'], 'copy.pdf'),
    ).toMatchObject({ status: 'identified', candidates: [{ page: 2, kind: 'methodology' }] })
    expect(identifyDocument(['', ''], 'ГОСТ Р 90001-2030.pdf')).toMatchObject({
      status: 'no-text',
      candidates: [],
      filenameSuggestion: { edition: '2030' },
    })
  })

  it('recognizes a quoted cover before a preface mentioning an incorporated amendment', () => {
    const result = identifyDocument(
      [
        '"ГОСТ Р 90001-2030. Национальный стандарт\nУчебные правила"',
        'Примечание к документу\nИзменение N 2 ГОСТ Р 90001-2030, введено в действие.',
      ],
      'copy.pdf',
    )
    expect(result.candidates).toEqual([
      expect.objectContaining({
        code: 'ГОСТ Р 90001',
        edition: '2030',
        documentType: 'base',
        page: 1,
      }),
    ])
  })

  it('rejects citations and normative reference lists as document titles', () => {
    for (const page of [
      'Условия выбираются по ГОСТ Р 90001-2030.',
      '2 Нормативные ссылки\nГОСТ Р 90001-2030 Учебные правила',
      'ВЗАМЕН ГОСТ Р 90001-2030',
    ])
      expect(identifyDocument([page], 'copy.pdf')).toMatchObject({
        status: 'unrecognized',
        candidates: [],
      })
  })

  it('shows ambiguous titles instead of choosing a referenced code by filename', () => {
    const result = identifyDocument(
      ['ГОСТ Р 90001-2030\nГОСТ Р 90002-2031'],
      'ГОСТ Р 90001-2030.pdf',
    )
    expect(result.status).toBe('ambiguous')
    expect(result.candidates.map((item) => item.code)).toEqual(['ГОСТ Р 90001', 'ГОСТ Р 90002'])
  })

  it.each([
    ['Изменение № 2 к ГОСТ Р 90001-2030\nУчебное изменение', 'amendment', 'Изменение № 2'],
    ['Изменение № 1\nк ГОСТ Р 90001-2030', 'amendment', 'Изменение № 1'],
    ['Поправка к\nГОСТ Р 90001-2030', 'correction', 'Поправка'],
  ])('distinguishes a change from the base edition: %s', (text, documentType, edition) => {
    expect(identifyDocument([text], 'change.pdf').candidates).toEqual([
      expect.objectContaining({ code: 'ГОСТ Р 90001', baseEdition: '2030', edition, documentType }),
    ])
  })
})
