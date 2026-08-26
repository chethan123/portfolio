import { Form } from "react-router";

import { FORM_ERROR, NotFoundError, ValidationError, formFields } from "~/lib/input.server";
import { createPerson, listPeople, removePerson, renamePerson } from "~/lib/people.server";

import type { Route } from "./+types/people";

/**
 * Settings → People.
 *
 * A thin wrapper, on purpose: it reads the form, hands the raw fields to
 * `people.server.ts`, and renders whatever comes back. Every rule about what a
 * name is, and every reason a person cannot be removed, lives in that module —
 * so a second caller cannot get a different answer than this screen does.
 */
export function meta() {
  return [{ title: "People · Settings · Portfolio" }];
}

export async function loader() {
  return { people: await listPeople() };
}

export async function action({ request }: Route.ActionArgs) {
  const values = formFields(await request.formData());
  const { intent, personId } = values;

  try {
    switch (intent) {
      case "create":
        await createPerson(values);
        break;
      case "rename":
        await renamePerson(personId ?? "", values);
        break;
      case "remove":
        await removePerson(personId ?? "");
        break;
      default:
        throw new Response(`Unknown intent ${JSON.stringify(intent)}.`, { status: 400 });
    }

    // No payload: the loader re-runs on its own after an action, so the list
    // below is the confirmation. Clearing the returned values is also what
    // empties the add box on success.
    return null;
  } catch (error) {
    // A refusal is an ordinary outcome of a form submission. It comes back with
    // what was typed so the form can re-render carrying it, rather than making
    // someone retype a name because one field was wrong.
    if (error instanceof ValidationError) {
      // Split here rather than in the component: `FORM_ERROR` lives in a
      // `.server` module, and a component that referenced it would drag that
      // module — and the database with it — into the client bundle. The action
      // is stripped from that bundle, so this is the right side of the line.
      const { [FORM_ERROR]: formError, ...fieldErrors } = error.fieldErrors;

      return {
        intent,
        personId: personId ?? null,
        errors: fieldErrors,
        formError: formError ?? null,
        values,
      };
    }
    if (error instanceof NotFoundError) throw new Response(error.message, { status: 404 });
    throw error;
  }
}

export default function People({ loaderData, actionData }: Route.ComponentProps) {
  const { people } = loaderData;

  /** The messages for one row's rename form, or for the add form. */
  const errorsFor = (intent: string, personId: string | null = null) =>
    actionData?.intent === intent && actionData.personId === personId
      ? actionData.errors
      : undefined;

  // A removal refusal names accounts rather than a field, so it is shown above
  // the list it is about instead of beside a box.
  const removalRefusal = actionData?.intent === "remove" ? actionData.formError : null;

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">People</h1>
          <p className="page-subtitle">
            Who is in the household. Every account belongs to exactly one person, so this is
            the first thing to fill in — accounts cannot be created until someone is here to
            own them.
          </p>
        </div>
      </header>

      {removalRefusal ? (
        <p className="form-error" role="alert">
          {removalRefusal}
        </p>
      ) : null}

      {people.length === 0 ? (
        <p className="empty-note">Nobody is recorded yet.</p>
      ) : (
        <section className="panel">
          <ul className="record-list">
            {people.map((person) => {
              const errors = errorsFor("rename", person.id);

              return (
                <li key={person.id}>
                  {/* The row *is* the form. `.record` and `.record-form` both
                      pad, so nesting one in the other would inset every row
                      twice over. */}
                  <Form method="post" className="record record-form">
                    <input type="hidden" name="personId" value={person.id} />

                    {/* The box and its refusal are one flex item, the shape
                        `AccountFields` uses, so the sentence stacks under the
                        box it is about. Loose in the row they were siblings:
                        the refusal was laid out *beside* the box, 147px to the
                        right of it, and it pushed the count and the buttons of
                        that row out of line with every other row's. */}
                    <div>
                      <label className="visually-hidden" htmlFor={`name-${person.id}`}>
                        Name
                      </label>
                      <input
                        id={`name-${person.id}`}
                        name="name"
                        // What was typed survives a refusal; otherwise the stored
                        // name is what the box shows.
                        defaultValue={errors ? (actionData?.values.name ?? "") : person.name}
                        aria-invalid={errors?.name ? true : undefined}
                      />

                      {errors?.name ? (
                        <p className="field-error" role="alert">
                          {errors.name}
                        </p>
                      ) : null}
                    </div>

                    <p className="record-note">
                      {person.accountCount === 0 ? (
                        "No accounts"
                      ) : (
                        <>
                          <span className="u-data">{person.accountCount}</span> account
                          {person.accountCount === 1 ? "" : "s"}
                        </>
                      )}
                    </p>

                    {/* Grouped, and pushed to the trailing edge by the group
                        rather than by the row: two actions on one record read
                        as a pair, and `space-between` on the row drew them a
                        quarter of the screen apart. */}
                    <div className="record-actions">
                      {/* Outlined, not filled: a list of five Saves would leave
                          the page with five primary actions and no obvious one.
                          The filled button belongs to "Add person" below. */}
                      <button
                        type="submit"
                        name="intent"
                        value="rename"
                        className="button button--quiet"
                      >
                        Save
                      </button>
                      <button
                        type="submit"
                        name="intent"
                        value="remove"
                        className="button button--danger"
                        // Not disabled when they own accounts: the refusal explains
                        // itself, and a dead button explains nothing.
                        aria-label={`Remove ${person.name}`}
                      >
                        Remove
                      </button>
                    </div>
                  </Form>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="panel">
        <header className="panel-header">
          <h2 className="panel-title">Add a person</h2>
        </header>

        <Form method="post" className="panel-form">
          <div>
            <label htmlFor="new-person-name">
              Name
              <input
                id="new-person-name"
                name="name"
                defaultValue={errorsFor("create") ? (actionData?.values.name ?? "") : ""}
                aria-invalid={errorsFor("create")?.name ? true : undefined}
                autoComplete="off"
              />
            </label>

            {errorsFor("create")?.name ? (
              <p className="field-error" role="alert">
                {errorsFor("create")?.name}
              </p>
            ) : null}
          </div>

          <button type="submit" name="intent" value="create" className="button">
            Add person
          </button>
        </Form>
      </section>
    </>
  );
}
