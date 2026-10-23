import { expect, test, type Page } from '@playwright/test'
import {
  parameterDefinitions,
  type ParameterDefinition,
  type ParameterState,
} from '../../src/domain/normative-parameters'

function parameterState(
  definition: ParameterDefinition,
  index: number,
  confirmed: boolean,
): ParameterState {
  const source = definition.source
  const documentId = source.kind === 'decision' ? null : 1
  const value = definition.fallback ?? (definition.type === 'number' ? 1 : { Условие: '1' })
  return {
    id: definition.id,
    status: { kind: confirmed ? 'confirmed' : 'unconfirmed' },
    document: null,
    quote: null,
    suggestion: null,
    confirmation: confirmed
      ? {
          id: index + 1,
          parameterId: definition.id,
          documentId,
          documentLabel: source.kind === 'decision' ? 'Решение составителя' : source.documentCode,
          clause:
            source.kind === 'decision'
              ? ''
              : source.kind === 'table'
                ? source.clause
                : `п. ${source.clause}`,
          page: source.kind === 'decision' ? null : 1,
          quote: 'Учебная цитата',
          fragment: 'Учебная цитата',
          value,
          confirmedBy: 'Автоматическая проверка',
          confirmedAt: '2026-10-23T00:00:00.000Z',
          note: '',
        }
      : null,
    amendments: [],
  }
}

async function backToProjects(page: Page): Promise<void> {
  await page.locator('.top-actions').getByRole('button', { name: 'Проекты', exact: true }).click()
  // В реальном импорте статус обновляет событие; здесь имитируем новое чтение после записи.
  await page.reload()
}

test('first run guides signs, PU-66 and parameters, then collapses to a status line', async ({
  page,
}) => {
  let signs: unknown[] = []
  let cards: unknown[] = []
  let confirmed = false
  await page.route('**/api/signs', (route) => route.fulfill({ json: signs }))
  await page.route('**/api/pu66', (route) => route.fulfill({ json: cards }))
  await page.route('**/api/normative-parameters', (route) =>
    route.fulfill({
      json: parameterDefinitions.map((definition, index) =>
        parameterState(definition, index, confirmed),
      ),
    }),
  )

  await page.goto('/')
  const wizard = page.getByTestId('first-run-wizard')
  await expect(wizard.getByRole('heading', { name: 'Настройте программу за 3 шага' })).toBeVisible()
  await expect(wizard.getByRole('heading', { name: '1. Добавьте дорожные знаки' })).toBeVisible()
  await expect(wizard.getByRole('button', { name: 'Далее', exact: true })).toBeDisabled()
  await wizard.getByRole('button', { name: 'Добавить ГОСТ Р 52290' }).click()
  await expect(
    page.getByRole('button', { name: 'Нормативные документы', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  await backToProjects(page)
  await wizard.getByRole('button', { name: 'Извлечь знаки из PDF' }).click()
  await expect(page.getByRole('heading', { name: 'Локальные реестры' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Импорт Excel и знаков' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  signs = [{ code: '1.25' }]
  await backToProjects(page)
  await expect(
    wizard.getByRole('heading', { name: '2. Импортируйте карточки переездов' }),
  ).toBeVisible()
  await expect(wizard.getByRole('button', { name: 'Далее', exact: true })).toBeDisabled()
  await wizard.getByRole('button', { name: 'Импортировать книги ПУ-66' }).click()
  await expect(page.getByRole('heading', { name: 'Локальные реестры' })).toBeVisible()

  cards = [{ referenceId: 'TEST-001' }]
  await backToProjects(page)
  await expect(
    wizard.getByRole('heading', { name: '3. Подтвердите нормативные параметры' }),
  ).toBeVisible()
  const pddTotal = parameterDefinitions.filter(
    (definition) => 'documentCode' in definition.source && definition.source.documentCode === 'ПДД',
  ).length
  await expect(wizard.getByRole('status')).toContainText(
    `Подтверждено 0 из ${parameterDefinitions.length} · ПДД: 0 из ${pddTotal}`,
  )
  await wizard.getByRole('button', { name: 'Добавить нормативные документы' }).click()
  await expect(
    page.getByRole('button', { name: 'Нормативные документы', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  await backToProjects(page)
  await wizard.getByRole('button', { name: 'Проверить параметры' }).click()
  await expect(
    page.getByRole('button', { name: 'Нормативные параметры', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')

  confirmed = true
  await backToProjects(page)
  await expect(wizard.getByText('Настройка завершена', { exact: true })).toBeVisible()
  await expect(wizard).toContainText('Знаков: 1 · карточек ПУ-66: 1 · параметров:')
  await expect(wizard.getByRole('heading', { name: 'Настройте программу за 3 шага' })).toHaveCount(
    0,
  )

  await wizard.getByRole('button', { name: 'Проверить настройку' }).click()
  await expect(
    wizard.getByRole('heading', { name: '3. Подтвердите нормативные параметры' }),
  ).toBeVisible()
  await wizard.getByRole('button', { name: 'Завершить настройку' }).click()
  await expect(wizard.getByText('Настройка завершена', { exact: true })).toBeVisible()
})
