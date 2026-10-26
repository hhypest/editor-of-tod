import type { DatabaseSync } from 'node:sqlite'
import type { ParameterConfirmation } from '../../src/domain/normative-parameters.ts'

export class ParameterConfirmationRepository {
  private readonly db: DatabaseSync
  private readonly now: () => string

  constructor(db: DatabaseSync, now: () => string) {
    this.db = db
    this.now = now
  }

  list(): ParameterConfirmation[] {
    return (
      this.db
        .prepare(
          `SELECT id, parameter_id, document_id, document_label, clause, page, quote, fragment,
                  value_json, confirmed_by, confirmed_at, note
             FROM parameter_confirmations ORDER BY parameter_id, id`,
        )
        .all() as Array<Record<string, unknown>>
    ).map((row) => ({
      id: Number(row.id),
      parameterId: String(row.parameter_id),
      documentId: row.document_id === null ? null : Number(row.document_id),
      documentLabel: String(row.document_label),
      clause: String(row.clause),
      page: row.page === null ? null : Number(row.page),
      quote: String(row.quote),
      fragment: String(row.fragment),
      value: JSON.parse(String(row.value_json)) as ParameterConfirmation['value'],
      confirmedBy: String(row.confirmed_by),
      confirmedAt: String(row.confirmed_at),
      note: String(row.note),
    }))
  }

  add(input: Omit<ParameterConfirmation, 'id'>): ParameterConfirmation {
    const row = this.db
      .prepare(
        `INSERT INTO parameter_confirmations
          (parameter_id, document_id, document_label, clause, page, quote, fragment, value_json,
           confirmed_by, confirmed_at, note, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        input.parameterId,
        input.documentId,
        input.documentLabel,
        input.clause,
        input.page,
        input.quote,
        input.fragment,
        JSON.stringify(input.value),
        input.confirmedBy,
        input.confirmedAt,
        input.note,
        this.now(),
      ) as { id: number }
    return { ...input, id: row.id }
  }
}
