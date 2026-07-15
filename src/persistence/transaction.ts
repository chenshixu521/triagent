import type { DatabaseSync } from 'node:sqlite';

const activeTransactions = new WeakSet<DatabaseSync>();
const poisonedTransactions = new WeakSet<DatabaseSync>();

export type AsyncCallbackGuard<Result> = [Result] extends [never]
  ? []
  : Result extends PromiseLike<unknown>
    ? [asyncCallbacksAreForbidden: never]
    : [];

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { readonly then?: unknown }).then === 'function'
  );
}

export function withTransaction<Result>(
  database: DatabaseSync,
  operation: () => Result,
  ..._asyncGuard: AsyncCallbackGuard<Result>
): Result {
  if (poisonedTransactions.has(database)) {
    throw new Error(
      'database transaction connection is poisoned and must be closed',
    );
  }
  if (activeTransactions.has(database)) {
    throw new Error('nested transaction is not allowed');
  }

  activeTransactions.add(database);
  let began = false;
  try {
    database.exec('BEGIN IMMEDIATE');
    began = true;
    const result = operation();
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch(() => undefined);
      let rollbackError: unknown;
      try {
        database.exec('ROLLBACK');
      } catch (error) {
        rollbackError = error;
      }
      began = false;
      poisonedTransactions.add(database);
      let closeError: unknown;
      try {
        database.close();
      } catch (error) {
        closeError = error;
      }
      if (rollbackError !== undefined || closeError !== undefined) {
        throw new AggregateError(
          [rollbackError, closeError].filter((error) => error !== undefined),
          'AsyncCallbackError: async transaction callback was rejected, but rollback or close failed; database connection is poisoned',
        );
      }
      throw new Error(
        'AsyncCallbackError: transaction callbacks must be synchronous; transaction was rolled back and the database connection was closed',
      );
    }
    database.exec('COMMIT');
    began = false;
    return result;
  } catch (error) {
    if (began) {
      try {
        database.exec('ROLLBACK');
      } catch (rollbackError) {
        poisonedTransactions.add(database);
        let closeError: unknown;
        try {
          database.close();
        } catch (closeFailure) {
          closeError = closeFailure;
        }
        const operationMessage =
          error instanceof Error ? error.message : String(error);
        const rollbackMessage =
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError);
        throw new AggregateError(
          [error, rollbackError, closeError].filter(
            (failure) => failure !== undefined,
          ),
          `transaction failed (${operationMessage}) and rollback failed (${rollbackMessage}); database connection is poisoned and ${closeError === undefined ? 'was closed' : 'close also failed'}`,
          { cause: error },
        );
      }
    }
    throw error;
  } finally {
    activeTransactions.delete(database);
  }
}
