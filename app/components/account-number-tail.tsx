/**
 * An account's number tail beside its name — CONTEXT.md's display form of
 * the account number: four dots and its last four characters, shown wherever
 * accounts are listed, always and not only when names collide. An identifier,
 * not an amount, so masking never touches it. Takes the pre-masked tail
 * (`numberTail()`'s product), never the number itself: loader data is
 * serialized to the browser, so the raw value must already be gone by the
 * time anything can render it. One component rather than three copies because
 * the aria arrangement is the part a second copy would drop: the dots are
 * hidden — four bullets read out one by one say nothing — and a
 * visually-hidden span says "ending in" instead, in characters because the
 * stored number is free text and the tail may hold letters. Renders nothing
 * for an account with no recorded number: the bare name is the honest label.
 */
export function AccountNumberTail({ tail }: { tail: string | null }) {
  if (tail === null) return null;

  return (
    <>
      {" "}
      <span className="number-tail" aria-hidden="true">
        {tail}
      </span>
      {/* numberTail()'s glyph prefix is exactly four dots; what follows them
          is what the announcement names. */}
      <span className="visually-hidden">ending in {tail.slice(4)}</span>
    </>
  );
}
