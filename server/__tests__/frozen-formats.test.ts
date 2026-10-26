import { openTestApplication } from './test-application'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { exportSchemeJson, importSchemeJson } from '../../src/domain/import'
import { parseStoredScheme, schemeSchema } from '../../src/domain/model'
import { schemeLayout } from '../../src/domain/placement-workspace'
import { reviewScheme } from '../../src/domain/review-scheme'
import { decisionEvidenceState } from '../../src/domain/decision-evidence'
import { switchLocation } from '../../src/domain/normative-defaults'
import { PROTOTYPE_RULES } from '../../src/domain/normative-parameters'
import { SCHEMA_VERSION } from '../database/schema-version'

/**
 * Файлы в tests/fixtures/frozen записаны прежними версиями программы (см. README там же)
 * и не меняются: по ним проверяется, что новая программа открывает старые проекты и базы.
 */
const root = fileURLToPath(new URL('../../tests/fixtures/frozen/', import.meta.url))
const projectFiles = readdirSync(join(root, 'projects')).sort()
const databaseFiles = readdirSync(join(root, 'databases')).sort((a, b) => version(a) - version(b))
const CURRENT_PROJECT_VERSION = schemeSchema.shape.schemaVersion.value

function version(filename: string): number {
  return Number(/-v(\d+)[-.]/.exec(filename)![1])
}

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('frozen files of previous formats', () => {
  it('are byte-identical to the recorded checksums', () => {
    const recorded = readFileSync(join(root, 'SHA256SUMS'), 'utf8').trimEnd().split('\n')
    const actual = [
      ...projectFiles.map((name) => `projects/${name}`),
      ...databaseFiles.map((name) => `databases/${name}`),
    ]
      .sort()
      .map(
        (path) =>
          `${createHash('sha256')
            .update(readFileSync(join(root, path)))
            .digest('hex')}  ${path}`,
      )
    expect(actual).toEqual(recorded)
  })

  it('cover every project format since v2 and every database version since 3', () => {
    const projects = new Set(projectFiles.map(version))
    for (let v = 2; v <= CURRENT_PROJECT_VERSION; v++) expect(projects, `проект v${v}`).toContain(v)
    const databases = databaseFiles.map(version)
    expect(databases).toEqual(Array.from({ length: SCHEMA_VERSION - 2 }, (_, index) => index + 3))
  })

  describe.each(projectFiles)('project %s', (filename) => {
    const text = readFileSync(join(root, 'projects', filename), 'utf8')
    const original = JSON.parse(text) as {
      schemaVersion: number
      id: string
      createdAt: string
      template: { code: string }
      crossing: { referenceId: string }
      placements: Array<{ id: number }>
      parameters: { speedStagesKmh: number[]; workZones: Record<string, unknown> }
      reviewMarks?: Record<string, unknown>
    }

    it('opens as the current format and keeps what the file stated', async () => {
      expect(original.schemaVersion).toBe(version(filename))
      const imported = importSchemeJson(text)
      const scheme = imported.scheme
      expect(scheme.schemaVersion).toBe(CURRENT_PROJECT_VERSION)
      expect(scheme.id).toBe(original.id)
      expect(scheme.createdAt).toBe(original.createdAt)
      expect(scheme.template.code).toBe(original.template.code)
      expect(scheme.crossing.referenceId).toBe(original.crossing.referenceId)
      expect(scheme.placements.map((placement) => placement.id)).toEqual(
        original.placements.map((placement) => placement.id),
      )
      expect(scheme.parameters.speedStagesKmh).toEqual(original.parameters.speedStagesKmh)
      expect(Object.keys(scheme.parameters.workZones)).toEqual(
        Object.keys(original.parameters.workZones),
      )
      expect(Object.keys(scheme.reviewMarks)).toEqual(Object.keys(original.reviewMarks ?? {}))
      // Стойки прежних форматов не сдвинулись: расстояние получила только та, чьё выведенное
      // место совпало с сохранённым (ADR-0003, ADR-0008).
      const layout = schemeLayout(scheme)
      for (const placement of scheme.placements) {
        if (placement.kind !== 'sign-post' || !placement.distance) continue
        const { anchor, offsetXSvg } = placement.position
        const stored = offsetXSvg + (anchor === 'abs' ? 0 : layout.anchors[anchor])
        if (original.schemaVersion < 10)
          expect(
            Math.abs(layout.coordinates(placement).x - stored),
            `стойка № ${placement.id}`,
          ).toBeLessThanOrEqual(3)
      }
      // Записанные основания остаются действующими после обновления формата (v9 → v10 меняет
      // стойки, отпечаток скорости пересчитывается миграцией — замечание Codex к PR #150).
      const evidence = (original as { decisionEvidence?: Record<string, unknown> }).decisionEvidence
      for (const kind of ['speed', 'regulation'] as const)
        if (evidence?.[kind])
          expect(decisionEvidenceState(scheme, kind, PROTOTYPE_RULES).status, kind).toBe('current')
      if (evidence?.speed) {
        // Стойки, изменённые после записи, делают запись устаревшей и после обновления.
        const changed = JSON.parse(text) as { placements: Array<Record<string, unknown>> }
        const post = changed.placements.find((item) => item.kind === 'sign-post')!
        post.signIds = [...(post.signIds as string[]), '3.25']
        expect(
          decisionEvidenceState(
            importSchemeJson(JSON.stringify(changed)).scheme,
            'speed',
            PROTOTYPE_RULES,
          ).status,
        ).toBe('stale')
      }
      // Проверки листа не должны падать на проекте, поднятом из старого формата.
      expect(() => reviewScheme(scheme)).not.toThrow()
      // v2–v4 не хранили разрешённую скорость: подстановка объявляется при открытии, а пункт
      // «Местоположение» просит проверить скорость после выбора (issue #100).
      const speedNotice = imported.warnings.filter((warning) => warning.includes('не хранилась'))
      if (original.schemaVersion <= 4) {
        expect(speedNotice).toEqual([
          'Разрешённая скорость на подходе в файле проекта прежней версии не хранилась: подставлено 60 км/ч — прежнее значение по умолчанию. Укажите местоположение на этапе 2 и проверьте разрешённую скорость и ступени скорости.',
        ])
        expect(scheme.parameters.location).toBe('auto')
        expect(reviewScheme(scheme).find((finding) => finding.id === 'location')?.detail).toContain(
          'Разрешённая скорость на подходе сейчас 60 км/ч',
        )
        // Выбор «вне населённого пункта» заменяет подставленные 60 км/ч значением по умолчанию.
        expect(switchLocation(scheme.parameters, 'out', PROTOTYPE_RULES).approachSpeedKmh).toBe(90)
      } else {
        expect(speedNotice.filter((warning) => warning.includes('формате v'))).toEqual([])
      }
      // Тот же снимок, прочитанный из истории SQLite, даёт тот же проект.
      expect(parseStoredScheme(JSON.parse(text))).toEqual(scheme)
      // Сохранение в текущем формате и повторное открытие ничего не меняют.
      expect(importSchemeJson(exportSchemeJson(scheme)).scheme).toEqual(scheme)
      await expect(`${JSON.stringify(scheme, null, 2)}\n`).toMatchFileSnapshot(
        join(root, 'expected', filename),
      )
    })
  })

  describe.each(databaseFiles)('database %s', (filename) => {
    const from = version(filename)

    function open() {
      const directory = mkdtempSync(join(tmpdir(), 'tod-frozen-db-'))
      directories.push(directory)
      const path = join(directory, 'registry.sqlite')
      const raw = new DatabaseSync(path)
      raw.exec(readFileSync(join(root, 'databases', filename), 'utf8'))
      raw.close()
      return { directory, store: openTestApplication(path, () => '2026-10-05T12:00:00.000Z') }
    }

    it('is updated to the current schema without losing its records', () => {
      const { directory, store } = open()
      try {
        expect(store.runtime.schemaVersion()).toBe(SCHEMA_VERSION)
        if (from === SCHEMA_VERSION) {
          expect(store.runtime.migratedFrom).toBeNull()
          expect(existsSync(join(directory, 'backups'))).toBe(false)
        } else {
          expect(store.runtime.migratedFrom).toBe(from)
          expect(readdirSync(join(directory, 'backups'))).toEqual([store.runtime.migrationBackup])
        }

        expect(store.legacy.listCrossings()).toMatchObject([
          { referenceId: 'TEST-001', revision: 1 },
        ])
        expect(store.legacy.listNormative()).toHaveLength(4)

        if (from >= 4) {
          const [project] = store.projects.list()
          expect(project).toMatchObject({ referenceId: 'TEST-001', revision: 2 })
          // Редакция в базе не переписана: клиенту сообщается её исходный формат, чтобы при
          // открытии показать то же предупреждение о стойках, что и для файла.
          const storedVersion = store.projects.get(project!.id)!.storedSchemaVersion
          expect(storedVersion).toBeGreaterThanOrEqual(2)
          expect(storedVersion).toBeLessThanOrEqual(CURRENT_PROJECT_VERSION)
          if (from < 13) expect(storedVersion).toBeLessThan(CURRENT_PROJECT_VERSION)
          const first = store.projects.getRevision(project!.id, 1)!.scheme
          const second = store.projects.get(project!.id)!.scheme
          expect(first.schemaVersion).toBe(CURRENT_PROJECT_VERSION)
          expect(first.placements).toHaveLength(2)
          expect(second.parameters.locationText).toBe('Учебный участок, вторая редакция')
          // Сохранение без правок переписывает снимок прежнего формата в текущий: сообщения о
          // прежнем формате при следующем открытии не повторяются (замечание Codex к PR #148).
          const resaved = store.projects.save(second, 2).revision
          expect(resaved).toBe(storedVersion! < CURRENT_PROJECT_VERSION ? 3 : 2)
          expect(store.projects.get(project!.id)!.storedSchemaVersion).toBe(CURRENT_PROJECT_VERSION)
          expect(store.projects.save(second, resaved).revision).toBe(resaved)
          const edited = { ...second, parameters: { ...second.parameters, locationText: 'Правка' } }
          expect(store.projects.save(edited, resaved).revision).toBe(resaved + 1)
        } else {
          expect(store.projects.list()).toEqual([])
        }

        const cards = store.pu66.list(true)
        // Станционные карточки появились в базе версии 7; до версии 9 их ключ не содержал
        // номера карточки, и обновление должно перенести запись под новый ключ.
        const station = 'ст.Учебная:88:3:к77'
        expect(cards.map((card) => [card.referenceId, card.revision])).toEqual(
          from >= 7
            ? [
                ['99999:88:3', 2],
                [station, 1],
              ]
            : [['99999:88:3', 2]],
        )
        expect(store.pu66.getScheme('99999:88:3')).toMatchObject({
          roadName: 'Условная дорога, уточнение',
        })
        if (from >= 7)
          expect(store.pu66.getScheme(station)).toMatchObject({
            roadName: 'Условная дорога у станции',
          })
        if (from >= 5)
          expect(store.pu66Verifications.list('99999:88:3')).toMatchObject([
            { verifiedAt: '2026-09-20', verifiedBy: 'Учебное подразделение А' },
          ])
        expect(store.pu66Lifecycle.getStatus('99999:88:3')).toMatchObject({ excluded: from >= 12 })
        expect(store.pu66.list()).toHaveLength((from >= 7 ? 2 : 1) - (from >= 12 ? 1 : 0))

        expect(store.signCatalog.list()).toMatchObject([{ code: '1.1_ж', width: 30, height: 30 }])
        expect(store.signCatalog.getPng('1.1_ж', false)?.subarray(1, 4)).toEqual(
          new Uint8Array(Buffer.from('PNG')),
        )

        if (from >= 8) {
          const [recovery] = store.recovery.list()
          expect(recovery).toMatchObject({ referenceId: 'TEST-001', fileName: 'учебный.json' })
          const saved = store.recovery.get(recovery!.sessionId)!
          expect(saved.scheme.schemaVersion).toBe(CURRENT_PROJECT_VERSION)
          expect(saved.detailsDraft?.parameters.locationText).toBe('Неприменённое значение')
        } else {
          expect(store.recovery.list()).toEqual([])
        }

        const documents = store.documents.list()
        expect(documents.map((document) => document.code)).toEqual(
          from >= 11 ? ['ГОСТ Р 90000', 'ОДМ 218.6.019'] : from >= 10 ? ['ГОСТ Р 90000'] : [],
        )
        expect(store.parameterConfirmations.list()).toMatchObject(
          from >= 11 ? [{ parameterId: 'odm-signs-hourly', value: 260 }] : [],
        )
      } finally {
        store.runtime.close()
      }
    })
  })
})
