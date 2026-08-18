import { useEffect, useRef } from "react";
import { Form, useNavigation } from "react-router";

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
    // below is the confirmation. Null is also the signal the component resets
    // the add form on — success, as opposed to the object a refusal returns.
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

  // Clear the add box once a person has actually been added.
  //
  // The input is uncontrolled, so without this it keeps what was typed: the
  // server renders an empty `defaultValue` on the next pass, but React does not
  // push that onto a mounted input, and the component does not remount because
  // the route did not change. A form still holding a name that has already been
  // added invites a second click and a duplicate person.
  //
  // A refusal must NOT clear it — that is the case where what was typed has to
  // survive — which is exactly what distinguishes the two: the action returns
  // null on success and an object carrying the messages on a refusal.
  const addForm = useRef<HTMLFormElement>(null);
  const navigation = useNavigation();

  useEffect(() => {
    if (navigation.state === "idle" && actionData === null) addForm.current?.reset();
  }, [navigation.state, actionData]);

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
      <h1>People</h1>
      <p className="page-lede">
        Who is in the household. Every account belongs to exactly one person, so this is the
        first thing to fill in — accounts cannot be created until someone is here to own them.
      </p>

      {removalRefusal ? (
        <p className="form-error" role="alert">
          {removalRefusal}
        </p>
      ) : null}

      {people.length === 0 ? (
        <p className="empty-note">Nobody is recorded yet.</p>
      ) : (
        <ul className="record-list">
          {people.map((person) => {
            const errors = errorsFor("rename", person.id);

            return (
              <li key={person.id} className="record">
                <Form method="post" className="record-form">
                  <input type="hidden" name="personId" value={person.id} />

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

                  <button type="submit" name="intent" value="rename">
                    Save
                  </button>
                  <button
                    type="submit"
                    name="intent"
                    value="remove"
                    className="button--quiet"
                    // Not disabled when they own accounts: the refusal explains
                    // itself, and a dead button explains nothing.
                    aria-label={`Remove ${person.name}`}
                  >
                    Remove
                  </button>

                  <p className="record-note">
                    {person.accountCount === 0
                      ? "No accounts"
                      : `${person.accountCount} account${person.accountCount === 1 ? "" : "s"}`}
                  </p>

                  {errors?.name ? (
                    <p className="field-error" role="alert">
                      {errors.name}
                    </p>
                  ) : null}
                </Form>
              </li>
            );
          })}
        </ul>
      )}

      <Form method="post" className="panel-form" ref={addForm}>
        <h2>Add a person</h2>

        <label htmlFor="new-person-name">Name</label>
        <input
          id="new-person-name"
          name="name"
          defaultValue={errorsFor("create") ? (actionData?.values.name ?? "") : ""}
          aria-invalid={errorsFor("create")?.name ? true : undefined}
          autoComplete="off"
        />

        {errorsFor("create")?.name ? (
          <p className="field-error" role="alert">
            {errorsFor("create")?.name}
          </p>
        ) : null}

        <button type="submit" name="intent" value="create">
          Add person
        </button>
      </Form>
    </>
  );
}
