import type { ParameterConfirmation } from '../../src/domain/normative-parameters'

export const evidenceConfirmation = (
  partial: Partial<Omit<ParameterConfirmation, 'id'>> = {},
): Omit<ParameterConfirmation, 'id'> => ({
  parameterId: 'fictional-value',
  documentId: null,
  documentLabel: '',
  clause: '',
  page: null,
  quote: '',
  fragment: '',
  value: 123,
  confirmedBy: '  Учебный специалист  ',
  confirmedAt: '2030-01-30',
  note: '  Учебное основание  ',
  ...partial,
})
