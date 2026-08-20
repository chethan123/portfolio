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
 *
 * Each field is one element: `.panel-form` wraps its children across lines, so
 * a caption, a box and the note under it have to travel together or a refusal
 * message ends up beside the field after the one it is about.
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
      <div>
        {/* The box is nested in its label rather than pointed at from beside
            it: `label` is a flex column in the stylesheet, and that is what
            sets the caption directly above the box it names. */}
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
        <p className="field-note">
          A workplace plan holding both Traditional and Roth money is two accounts at the same
          institution, one of each treatment.
        </p>
        <Error_ name="taxTreatment" />
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
        <p className="field-note">
          Optional, and only ever used to pre-select this account when a statement carrying the
          same number is uploaded.
        </p>
        <Error_ name="externalAccountNumber" />
      </div>
    </>
  );
}
