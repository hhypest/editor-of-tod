/** Synchronous commands only: the transaction must cover the entire operation. */
export interface TransactionRunner {
  immediate<T>(operation: () => T): T
}
