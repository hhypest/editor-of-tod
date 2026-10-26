import { createHash } from 'node:crypto'
import {
  pu66LifecycleWriteSchema,
  type Pu66LifecycleWrite,
  type Pu66LifecyclePlan,
} from '../../src/domain/pu66-lifecycle.ts'
import { localCalendarDate } from '../../src/domain/pu66-review.ts'
import { InvalidPu66Lifecycle } from './errors.ts'
import { RevisionConflict } from '../storage-errors.ts'
import type { TransactionRunner } from '../transaction-runner.ts'
import type { Pu66Repository } from './repository.ts'
import type { Pu66LifecycleRepository } from './lifecycle-repository.ts'

export class Pu66LifecycleService {
  private readonly cards: Pick<Pu66Repository, 'list'>
  private readonly events: Pick<Pu66LifecycleRepository, 'getStatus' | 'append'>
  private readonly transactions: TransactionRunner
  private readonly now: () => string

  constructor(
    cards: Pick<Pu66Repository, 'list'>,
    events: Pick<Pu66LifecycleRepository, 'getStatus' | 'append'>,
    transactions: TransactionRunner,
    now: () => string,
  ) {
    this.cards = cards
    this.events = events
    this.transactions = transactions
    this.now = now
  }

  plan(raw: Pu66LifecycleWrite): Pu66LifecyclePlan {
    const input = pu66LifecycleWriteSchema.parse(raw)
    if (input.date > localCalendarDate(new Date(this.now())))
      throw new InvalidPu66Lifecycle('Дата действия не может быть в будущем.')
    const cards = this.cards.list(true)
    const items = input.keys.map((key) => {
      const card = cards.find((card) => card.referenceId === key)
      const status = this.events.getStatus(key)
      if (!card || !status) throw new InvalidPu66Lifecycle('Карточка не найдена. Обновите список.')
      if (status.excluded !== (input.action === 'restore')) throw new RevisionConflict()
      return {
        referenceId: key,
        location: card.location,
        roadName: card.roadName,
        revision: card.revision,
        status,
      }
    })
    let successor: (typeof items)[number] | null = null
    if (input.action === 'exclude' && input.successorKey) {
      const status = this.events.getStatus(input.successorKey)
      const card = cards.find((card) => card.referenceId === input.successorKey)
      if (!status || !card || status.excluded || input.keys.includes(status.referenceId))
        throw new InvalidPu66Lifecycle('Преемник должен быть другой действующей карточкой.')
      // A new link is recorded explicitly; legacy key aliases keep their original meaning.
      const key = status.referenceId
      if (key !== input.successorKey)
        throw new InvalidPu66Lifecycle('Выберите текущий ключ карточки-преемника.')
      successor = {
        referenceId: key,
        location: card.location,
        roadName: card.roadName,
        revision: card.revision,
        status,
      }
    }
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ input, items, successor }))
      .digest('hex')
    return { fingerprint, items, successor }
  }

  record(input: Pu66LifecycleWrite, expectedFingerprint: string): number {
    return this.transactions.immediate(() => {
      const plan = this.plan(input)
      if (plan.fingerprint !== expectedFingerprint) throw new RevisionConflict()
      this.events.append(input, plan.items)
      return plan.items.length
    })
  }
}
