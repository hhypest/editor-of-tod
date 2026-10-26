import { createHash } from 'node:crypto'
import type { Pu66ImportRestore } from '../../src/domain/pu66-lifecycle.ts'
import type { Pu66Import } from '../pu66.ts'
import type { TransactionRunner } from '../transaction-runner.ts'
import type { Pu66ImportRepository, Pu66ImportCounts, Pu66ImportItem } from './import-repository.ts'
import type { Pu66LifecycleService } from './lifecycle-service.ts'
import type { Pu66LifecycleRepository } from './lifecycle-repository.ts'
import { InvalidPu66Lifecycle, InvalidPu66Upload } from './errors.ts'

export class Pu66ImportService {
  private readonly imports: Pick<Pu66ImportRepository, 'inspect' | 'write'>
  private readonly lifecycle: Pick<Pu66LifecycleService, 'plan'>
  private readonly events: Pick<Pu66LifecycleRepository, 'appendImportRestores'>
  private readonly transactions: TransactionRunner

  constructor(
    imports: Pick<Pu66ImportRepository, 'inspect' | 'write'>,
    lifecycle: Pick<Pu66LifecycleService, 'plan'>,
    events: Pick<Pu66LifecycleRepository, 'appendImportRestores'>,
    transactions: TransactionRunner,
  ) {
    this.imports = imports
    this.lifecycle = lifecycle
    this.events = events
    this.transactions = transactions
  }

  inspect(entries: Pu66Import[]): Pu66ImportItem[] {
    return this.imports.inspect(entries)
  }

  plan(entries: Pu66Import[]): Pu66ImportCounts {
    const result = { added: 0, updated: 0, unchanged: 0 }
    for (const entry of this.imports.inspect(entries)) {
      if (entry.action === 'add') result.added++
      else if (entry.action === 'update') result.updated++
      else result.unchanged++
    }
    return result
  }

  preview(entries: Pu66Import[], restoration: Pu66ImportRestore | null = null) {
    let items: Pu66ImportItem[]
    try {
      items = this.imports.inspect(entries)
    } catch (error) {
      throw new InvalidPu66Upload(error instanceof Error ? error.message : 'Повторный ключ ПУ-66.')
    }
    const counts = { added: 0, updated: 0, unchanged: 0 }
    for (const item of items) {
      if (item.action === 'add') counts.added++
      else if (item.action === 'update') counts.updated++
      else counts.unchanged++
    }
    if (restoration) {
      if (
        restoration.keys.some(
          (key) => !items.some((item) => item.referenceId === key && item.status?.excluded),
        )
      )
        throw new InvalidPu66Upload('Возвращать можно только исключённые карточки из этого пакета.')
      this.lifecycle.plan({
        ...restoration,
        action: 'restore',
        comment: 'Возврат при импорте XLSX.',
      })
    }
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ items, restoration }))
      .digest('hex')
    return {
      ...counts,
      restored: restoration?.keys.length ?? 0,
      fingerprint,
      items: items.map(
        ({ filename, referenceId, location, roadName, action, currentRevision, status }) => ({
          filename,
          referenceId,
          location,
          roadName,
          action,
          currentRevision,
          status,
        }),
      ),
    }
  }

  record(entries: Pu66Import[], restoration: Pu66ImportRestore | null = null): Pu66ImportCounts {
    const result = this.plan(entries)
    return this.transactions.immediate(() => {
      if (restoration) {
        if (restoration.keys.some((key) => !entries.some((entry) => entry.card.key === key)))
          throw new InvalidPu66Lifecycle('Карточка для возврата отсутствует в пакете импорта.')
        this.lifecycle.plan({
          ...restoration,
          action: 'restore',
          comment: 'Возврат при импорте XLSX.',
        })
      }
      this.imports.write(entries)
      if (restoration) this.events.appendImportRestores(restoration)
      return result
    })
  }
}
