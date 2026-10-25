import type { DatabaseSync } from 'node:sqlite'

export interface Migration {
  readonly from: number
  readonly to: number
  readonly name: string
  run(context: { db: DatabaseSync }): void
}
