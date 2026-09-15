// Serializes every write that can change an account's current position history. A position set is
// a complete snapshot, so its latest-set read and append must share this transaction and row lock.
import { type Database } from "./db.server.ts";
import { NotFoundError } from "./input.server.ts";

import type { Kysely } from "kysely";

export async function withAccountWrite<T>(
  accountId: string,
  db: Kysely<Database>,
  body: (trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
  if (!/^\d+$/.test(accountId)) throw new NotFoundError(`No account with id ${accountId}.`);

  const run = async (trx: Kysely<Database>): Promise<T> => {
    // READ COMMITTED: the re-read must see the writer ahead. Several accounts: lock ids in order.
    const account = await trx
      .selectFrom("account")
      .select("id")
      .where("id", "=", accountId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (account === undefined) throw new NotFoundError(`No account with id ${accountId}.`);

    return body(trx);
  };

  // Kysely refuses .transaction() on a transaction; tests and composed writers pass one.
  return db.isTransaction ? run(db) : db.transaction().execute(run);
}
