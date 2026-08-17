import { ACCOUNT_KINDS, TAX_TREATMENTS } from "~/lib/account-options";

import type { FieldErrors } from "~/lib/input.server";

/**
 * The account form, shared by "add" and "edit".
 *
 * One component rather than two similar forms: the two screens must offer the
 * same fields with the same labels, and the cheapest way to guarantee that is
 * to have only one of them. The options come from `account-options.ts`, the
 * same list the domain module validates against, so what can be chosen here is
 * exactly what the schema's check constraints allow.
 */
export type AccountFieldValues = {
  name?: string;
  institution?: string;
  kind?: string;
  ownerId?: string;
  taxTreatment?: string;
  externalAccountNumber?: string;
};

export function AccountFields({
  people,
  values = {},
  errors,
  idPrefix,
}: {
  people: ReadonlyArray<{ id: string; name: string }>;
  /** What the boxes start with — the stored account, or what was just typed. */
  values?: AccountFieldValues;
  errors?: FieldErrors;
  /** Keeps `id`/`htmlFor` unique when two of these ever share a page. */
  idPrefix: string;
}) {
  const field = (name: string) => `${idPrefix}-${name}`;

  /** A message under its own box, or nothing. */
  const Error_ = ({ name }: { name: string }) =>
    errors?.[name] ? (
      <p className="field-error" role="alert">
        {errors[name]}
      </p>
    ) : null;

  return (
    <>
      <label htmlFor={field("name")}>Name</label>
      <input
        id={field("name")}
        name="name"
        defaultValue={values.name ?? ""}
        aria-invalid={errors?.name ? true : undefined}
        autoComplete="off"
      />
      <Error_ name="name" />

      <label htmlFor={field("institution")}>Institution</label>
      <input
        id={field("institution")}
        name="institution"
        defaultValue={values.institution ?? ""}
        placeholder="Fidelity, Schwab, your credit union…"
        aria-invalid={errors?.institution ? true : undefined}
        autoComplete="off"
      />
      <Error_ name="institution" />

      <label htmlFor={field("kind")}>Kind</label>
      <select
        id={field("kind")}
        name="kind"
        defaultValue={values.kind ?? ""}
        aria-invalid={errors?.kind ? true : undefined}
      >
        <option value="">Choose…</option>
        {ACCOUNT_KINDS.map((kind) => (
          <option key={kind.value} value={kind.value}>
            {kind.label}
          </option>
        ))}
      </select>
      <Error_ name="kind" />

      <label htmlFor={field("ownerId")}>Owner</label>
      <select
        id={field("ownerId")}
        name="ownerId"
        defaultValue={values.ownerId ?? ""}
        aria-invalid={errors?.ownerId ? true : undefined}
      >
        <option value="">Choose…</option>
        {people.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name}
          </option>
        ))}
      </select>
      <Error_ name="ownerId" />

      <label htmlFor={field("taxTreatment")}>Tax treatment</label>
      <select
        id={field("taxTreatment")}
        name="taxTreatment"
        defaultValue={values.taxTreatment ?? ""}
        aria-invalid={errors?.taxTreatment ? true : undefined}
      >
        <option value="">Choose…</option>
        {TAX_TREATMENTS.map((treatment) => (
          <option key={treatment.value} value={treatment.value}>
            {treatment.label}
          </option>
        ))}
      </select>
      <p className="field-note">
        A workplace plan holding both Traditional and Roth money is two accounts at the same
        institution, one of each treatment.
      </p>
      <Error_ name="taxTreatment" />

      <label htmlFor={field("externalAccountNumber")}>Account number</label>
      <input
        id={field("externalAccountNumber")}
        name="externalAccountNumber"
        defaultValue={values.externalAccountNumber ?? ""}
        aria-invalid={errors?.externalAccountNumber ? true : undefined}
        autoComplete="off"
      />
      <p className="field-note">
        Optional, and only ever used to pre-select this account when a statement carrying the
        same number is uploaded.
      </p>
      <Error_ name="externalAccountNumber" />
    </>
  );
}
