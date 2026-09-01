/**
 * An account's number tail beside its name — CONTEXT.md's display form of
 * the account number: four dots and its last four characters, shown wherever
 * accounts are listed, always and not only when names collide. An identifier,
 * not an amount, so masking never touches it. One component rather than three
 * copies because the aria arrangement is the part a second copy would drop:
 * the dots are hidden — four bullets read out one by one say nothing — and a
 * visually-hidden span says "ending in" instead, in characters because the
 * stored number is free text and the tail may hold letters. Renders nothing
 * for an account with no recorded number: the bare name is the honest label.
 */
import { numberTail, numberTailCharacters } from "~/lib/account-label";

export function AccountNumberTail({ number }: { number: string | null }) {
  const tail = numberTail(number);
  if (tail === null) return null;

  return (
    <>
      {" "}
      <span className="number-tail" aria-hidden="true">
        {tail}
      </span>
      <span className="visually-hidden">ending in {numberTailCharacters(number)}</span>
    </>
  );
}
