import { describe, expect, it } from 'vitest'
import {
  helpLabels,
  helpSectionFor,
  helpSections,
  searchHelp,
  sectionText,
  splitLabels,
} from '../help-content'

/** Тексты интерфейса: исходники App.vue и компонентов. */
const sources = import.meta.glob(['../../App.vue', '../../components/*.vue'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

function interfaceText(): string {
  return Object.values(sources).join('\n').replace(/\s+/g, ' ')
}

describe('user help', () => {
  it('has unique section ids and no empty sections', () => {
    const ids = helpSections.map((section) => section.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const section of helpSections) expect(section.blocks.length).toBeGreaterThan(0)
  })

  it('names only buttons, fields and headings that exist in the interface', () => {
    const text = interfaceText()
    expect(Object.keys(sources).length).toBeGreaterThan(10)
    const missing = helpLabels().filter((label) =>
      label
        .split('…')
        .map((part) => part.trim())
        .filter(Boolean)
        .some((part) => !text.includes(part)),
    )
    expect(missing).toEqual([])
  })

  it('opens the section of the current screen', () => {
    const ids = new Set(helpSections.map((section) => section.id))
    for (const view of ['projects', 'source', 'geometry', 'objects', 'review', 'unknown'])
      expect(ids.has(helpSectionFor(view))).toBe(true)
    for (const tab of ['imports', 'documents', 'parameters', 'entries'])
      expect(ids.has(helpSectionFor('registries', tab))).toBe(true)
    expect(helpSectionFor('review')).toBe('stage-review')
    expect(helpSectionFor('registries', 'parameters')).toBe('parameters')
  })

  it('searches all words case-insensitively and treats ё as е', () => {
    expect(searchHelp('')).toHaveLength(helpSections.length)
    expect(searchHelp('сверки 30 января').map((section) => section.id)).toContain('pu66')
    expect(searchHelp('ЖЁЛТЫМ ФОНОМ').map((section) => section.id)).toContain('signs')
    expect(searchHelp('несуществующее слово')).toEqual([])
  })

  it('keeps labels readable in search text and splits them for display', () => {
    expect(sectionText(helpSections[0]!)).not.toContain('[[')
    expect(splitLabels('Нажмите [[Создать проект]].')).toEqual([
      { text: 'Нажмите ', label: false },
      { text: 'Создать проект', label: true },
      { text: '.', label: false },
    ])
  })
})
