import type { DatabaseSync } from 'node:sqlite'
import { AmbiguousPu66Key } from './errors.ts'

export class Pu66KeyResolver {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  /** Текущий ключ карточки; для старых станционных ключей — по таблице псевдонимов. */
  resolve(key: string): string | null {
    if (this.db.prepare('SELECT 1 FROM pu66_cards WHERE key = ?').get(key)) return key
    const alias = this.db
      .prepare('SELECT new_key FROM pu66_key_aliases WHERE old_key = ?')
      .get(key) as { new_key: string | null } | undefined
    if (!alias) return null
    if (alias.new_key === null) throw new AmbiguousPu66Key()
    return alias.new_key
  }
}
