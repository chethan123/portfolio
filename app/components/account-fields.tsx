import { ACCOUNT_KINDS, TAX_TREATMENTS } from "~/lib/account-options";

import type { FieldErrors } from "~/lib/input.server";

// Shared by "add" and "edit" — one component guarantees the same fields and labels. Refusal comes before the note (`tax.tsx`'s order).
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
  values?: AccountFieldValues;
  errors?: FieldErrors;
  idPrefix: string;
}) {
  const field = (name: string) => `${idPrefix}-${name}`;

  const Error_ = ({ name }: { name: string }) =>
    errors?.[name] ? (
      <p className="field-error" role="alert">
        {errors[name]}
      </p>
    ) : null;

  return (
    <>
      <div>
        <label htmlFor={field("name")}>
          Name
          <input
            id={field("name")}
            name="name"
            defaultValue={values.name ?? ""}
            aria-invalid={errors?.name ? true : undefined}
            autoComplete="off"
          />
        </label>
        <Error_ name="name" />
      </div>

      <div>
        <label htmlFor={field("institution")}>
          Institution
          <input
            id={field("institution")}
            name="institution"
            defaultValue={values.institution ?? ""}
            placeholder="Fidelity, Schwab, your credit union…"
            aria-invalid={errors?.institution ? true : undefined}
            autoComplete="off"
          />
        </label>
        <Error_ name="institution" />
      </div>

      <div>
        <label htmlFor={field("kind")}>
          Kind
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
        </label>
        <Error_ name="kind" />
      </div>

      <div>
        <label htmlFor={field("ownerId")}>
          Owner
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
        </label>
        <Error_ name="ownerId" />
      </div>

      <div>
        <label htmlFor={field("taxTreatment")}>
          Tax treatment
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
        </label>
        <Error_ name="taxTreatment" />
        <p className="field-note">
          A workplace plan holding both Traditional and Roth money is two accounts at the same
          institution, one of each treatment.
        </p>
      </div>

      <div>
        <label htmlFor={field("externalAccountNumber")}>
          Account number
          <input
            id={field("externalAccountNumber")}
            name="externalAccountNumber"
            defaultValue={values.externalAccountNumber ?? ""}
            aria-invalid={errors?.externalAccountNumber ? true : undefined}
            autoComplete="off"
          />
        </label>
        <Error_ name="externalAccountNumber" />
        <p className="field-note">
          Optional, and a check rather than a chooser: it never picks the account for an
          upload, but a statement naming a different number than the one recorded here is
          refused rather than landing in the wrong place.
        </p>
      </div>
    </>
  );
}
