// Identifier, not an amount — masking never touches it. Takes the pre-masked tail (`numberTail()`), never the raw number.
export function AccountNumberTail({ tail }: { tail: string | null }) {
  if (tail === null) return null;

  return (
    <>
      {" "}
      <span className="number-tail" aria-hidden="true">
        {tail}
      </span>
      {/* `numberTail()`'s glyph prefix is exactly four dots. */}
      <span className="visually-hidden">ending in {tail.slice(4)}</span>
    </>
  );
}
