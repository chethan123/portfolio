// Refusal paragraphs' markup, once. A string, not a ValidationError: the `form` split is
// `refused()`'s, server-side; nothing here crosses the `.server` line.
export function FieldError({ id, message }: { id?: string; message: string | null | undefined }) {
  return message ? (
    <p id={id} className="field-error" role="alert">
      {message}
    </p>
  ) : null;
}

export function FormError({ message }: { message: string | null | undefined }) {
  return message ? (
    <p className="form-error" role="alert">
      {message}
    </p>
  ) : null;
}
