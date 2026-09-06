import { Form, redirect } from "react-router";

import { isOwed } from "~/lib/account-options";
import { getAccount } from "~/lib/accounts.server";
import {
  NOT_IN_FILE,
  findMapping,
  headerFingerprint,
  parseMappingForm,
} from "~/lib/column-mapping.server";
import { defaultHeaderRow, headerRowChoices, readCsv } from "~/lib/csv";
import {
  FORM_ERROR,
  NotFoundError,
  ValidationError,
  formFields,
} from "~/lib/input.server";
import { parseStatement, statementMapping } from "~/lib/statement";
import { rememberMapping, requireDraft, type UploadDraft } from "~/lib/uploads.server";

import type { UploadStepsData } from "~/components/upload-steps";
import type { ParseProblem, StatementMapping } from "~/lib/statement";
import type { Route } from "./+types/columns";

/**
 * Step two — map the file's columns, once per institution (ingest brief
 * §4). A saved mapping prefills but the screen still renders every time — a
 * changed export must be visible, not silently reapplied. No client state:
 * header-row change is a GET, mapping a POST.
 */
export function meta() {
  return [{ title: "Columns · Upload · Portfolio" }];
}

// Form fields, in the order the screen draws them.
const COLUMN_CONTROLS = [
  { field: "instrument", caption: "Instrument", optional: false },
  { field: "quantity", caption: "Quantity", optional: false },
  { field: "name", caption: "Name", optional: true },
  { field: "costBasis", caption: "Cost basis", optional: true },
  { field: "asOf", caption: "As-of date", optional: true },
  { field: "accountNumber", caption: "Account number", optional: true },
] as const;

// Saved mapping forces its recorded delimiter, so a re-read can't disagree with the original sniff.
function readDraftFile(draft: UploadDraft) {
  const saved = statementMapping.safeParse(draft.mapping);
  const savedMapping = saved.success ? saved.data : null;
  const { rows, delimiter } = readCsv(draft.bytes, savedMapping?.delimiter);

  return { savedMapping, rows, delimiter };
}

export async function loader({ params, request }: Route.LoaderArgs) {
  try {
    const draft = await requireDraft(params.draftId);
    const account = await getAccount(draft.accountId);
    const { savedMapping, rows } = readDraftFile(draft);

    // Precedence: explicit `header` param, then the saved mapping's row, then candidate detection.
    const headerParam = new URL(request.url).searchParams.get("header");
    const requested =
      headerParam !== null && /^\d+$/.test(headerParam) ? Number(headerParam) : null;
    const headerRow =
      requested !== null && rows[requested] !== undefined
        ? requested
        : savedMapping !== null && rows[savedMapping.headerRow] !== undefined
          ? savedMapping.headerRow
          : (defaultHeaderRow(rows) ?? 0);

    const headerCells = rows[headerRow] ?? [];

    // Parsed here too, not only on POST — a bounce from review/instruments needs to explain itself on arrival.
    const savedParse = savedMapping === null ? null : parseStatement(rows, savedMapping);
    const savedProblems = savedParse === null ? [] : savedParse.problems;

    // Draft's own mapping wins over the institution's remembered one — the lookup only runs when the draft has none.
    const remembered =
      savedMapping ?? (await findMapping(account.institution, headerFingerprint(headerCells)));
    const fromInstitution = savedMapping === null && remembered !== null;

    // A saved column the file no longer has leaves its control unselected and is named in the intro.
    const missingColumns: string[] = [];
    let defaults: Record<string, string>;
    if (remembered === null) {
      defaults = {
        instrument: "",
        quantity: "",
        name: "",
        costBasis: "",
        asOf: "",
        accountNumber: "",
        costBasisIs: "per_share",
        owedAsPositive: isOwed(account.kind) ? "true" : "",
      };
    } else {
      // Matched by trimmed cell, same as `parseStatement`.
      const cellFor = (name: string): string | undefined =>
        headerCells.find((cell) => cell.trim() === name.trim());
      const value = (name: string | null | undefined, optional: boolean): string => {
        if (name === null || name === undefined || name === "") {
          return optional ? NOT_IN_FILE : "";
        }
        const cell = cellFor(name);
        if (cell === undefined) {
          missingColumns.push(name);
          return "";
        }
        return cell;
      };

      defaults = {
        instrument: value(remembered.columns.instrument, false),
        quantity: value(remembered.columns.quantity, false),
        name: value(remembered.columns.name, true),
        costBasis: value(remembered.columns.costBasis, true),
        asOf: value(remembered.columns.asOf, true),
        accountNumber: value(remembered.columns.accountNumber, true),
        costBasisIs: remembered.costBasisIs,
        owedAsPositive: remembered.owedAsPositive ? "true" : "",
      };
    }

    // Candidates first, then every other non-blank row (`headerRowChoices` — a real header can fail candidate detection).
    const headerOptions = headerRowChoices(rows, headerRow).map((index) => {
      const cells = (rows[index] ?? [])
        .map((cell) => cell.trim())
        .filter((cell) => cell !== "");
      return {
        index,
        label:
          `Row ${index + 1} — ${cells.slice(0, 4).join(" · ")}` +
          (cells.length > 4 ? " · …" : ""),
      };
    });

    // First three data rows, spacer lines skipped, padded to the header's width.
    const preview: string[][] = [];
    for (let index = headerRow + 1; index < rows.length && preview.length < 3; index++) {
      const cells = rows[index] ?? [];
      if (cells.every((cell) => cell.trim() === "")) continue;
      preview.push(headerCells.map((_, column) => cells[column] ?? ""));
    }

    return {
      steps: {
        current: 2,
        draftId: draft.id,
        instrumentsSkipped: false,
      } satisfies UploadStepsData,
      draft: {
        id: draft.id,
        filename: draft.filename,
        accountName: draft.accountName,
        ownerName: draft.ownerName,
        accountNumberTail: draft.accountNumberTail,
      },
      institution: account.institution,
      headerRow,
      headerOptions,
      headerCells,
      preview,
      defaults,
      fromInstitution,
      missingColumns,
      savedProblems: savedProblems.map((problem) => problem.message),
      savedProblemFields:
        savedMapping === null ? [] : problemFieldsOf(savedMapping, savedProblems),
      // Component can't import a `.server` module — sentinel rides down with the data.
      notInFile: NOT_IN_FILE,
    };
  } catch (error) {
    if (error instanceof NotFoundError) throw new Response(error.message, { status: 404 });
    throw error;
  }
}

/** Which select a parse problem's column belongs to, for `aria-invalid`. */
function problemFieldsOf(mapping: StatementMapping, problems: ParseProblem[]): string[] {
  const owners: Array<[string | null | undefined, string]> = [
    [mapping.columns.instrument, "instrument"],
    [mapping.columns.quantity, "quantity"],
    [mapping.columns.name, "name"],
    [mapping.columns.costBasis, "costBasis"],
    [mapping.columns.asOf, "asOf"],
    [mapping.columns.accountNumber, "accountNumber"],
  ];

  const fields = new Set<string>();
  for (const problem of problems) {
    if (problem.column === null) continue;
    const owner = owners.find(
      ([name]) => name !== null && name !== undefined && name.trim() === problem.column?.trim(),
    );
    if (owner !== undefined) fields.add(owner[1]);
  }

  return [...fields];
}

export async function action({ params, request }: Route.ActionArgs) {
  const values = formFields(await request.formData());

  try {
    const draft = await requireDraft(params.draftId);
    const { rows, delimiter } = readDraftFile(draft);

    const mapping = parseMappingForm(values, rows, delimiter);

    // Decides everything downstream: parses, remembers, and picks the next step — the same answer that lands on the draft.
    const outcome = await rememberMapping(draft.id, mapping);

    // Parse problems land here, not later (brief §4.5) — remapping is the fix, so the error belongs on this screen.
    if ("problems" in outcome) {
      return {
        errors: {} as Record<string, string>,
        formError: null,
        values,
        problems: outcome.problems.map((problem) => problem.message),
        problemFields: problemFieldsOf(mapping, outcome.problems),
      };
    }

    return redirect(`/upload/${draft.id}/${outcome.nextStep}`);
  } catch (error) {
    if (error instanceof ValidationError) {
      // Split here, not in the component — `FORM_ERROR`'s `.server` module can't reach the client bundle.
      const { [FORM_ERROR]: formError, ...fieldErrors } = error.fieldErrors;
      return {
        errors: fieldErrors,
        formError: formError ?? null,
        values,
        problems: [] as string[],
        problemFields: [] as string[],
      };
    }
    if (error instanceof NotFoundError) throw new Response(error.message, { status: 404 });
    throw error;
  }
}

export default function Columns({ loaderData, actionData }: Route.ComponentProps) {
  const {
    draft,
    institution,
    headerRow,
    headerOptions,
    headerCells,
    preview,
    defaults,
    fromInstitution,
    missingColumns,
    savedProblems,
    savedProblemFields,
    notInFile,
  } = loaderData;

  const errors = actionData?.errors;
  // Posted wins over saved — after a refused POST these describe that post; only a fresh GET shows the saved mapping's own.
  const problems = actionData?.problems ?? savedProblems;
  const problemFields = actionData?.problemFields ?? savedProblemFields;

  // Posted wins over saved. Whole record swapped, not merged — an absent checkbox means unticked.
  const values: Record<string, string | undefined> = actionData?.values ?? defaults;

  const invalid = (field: string): true | undefined =>
    errors?.[field] !== undefined || problemFields.includes(field) ? true : undefined;

  const columnSelect = (
    field: (typeof COLUMN_CONTROLS)[number]["field"],
    caption: string,
    optional: boolean,
  ) => (
    <div key={field}>
      <label htmlFor={`map-${field}`}>
        {caption}
        <select
          id={`map-${field}`}
          name={field}
          defaultValue={values[field] ?? ""}
          aria-invalid={invalid(field)}
        >
          <option value="">Choose…</option>
          {/* "unset" and "deliberately absent" are different answers — only the latter survives a save. */}
          {optional ? <option value={notInFile}>Not in this file</option> : null}
          {headerCells
            .filter((cell) => cell.trim() !== "")
            .map((cell, index) => (
              <option key={`${index}-${cell}`} value={cell}>
                {cell}
              </option>
            ))}
        </select>
      </label>
      {errors?.[field] ? (
        <p className="field-error" role="alert">
          {errors[field]}
        </p>
      ) : null}
    </div>
  );

  return (
    <section className="panel">
      <div className="panel-body form-intro">
        {/* Owner and number tail included — a bare name fails a house with two same-named accounts (brief §4.1). */}
        <p>
          <strong>{draft.filename}</strong> · {draft.accountName}
          {draft.accountNumberTail ? ` ${draft.accountNumberTail}` : ""} — owned by{" "}
          {draft.ownerName}
        </p>

        {fromInstitution ? (
          <p>
            These columns were mapped when a previous {institution || draft.accountName}{" "}
            statement was uploaded; the choices below are that mapping. Check them against the
            sample rows.
          </p>
        ) : null}

        {missingColumns.map((name) => (
          <p key={name}>
            The saved mapping used a column called "{name}", which this file does not have.
          </p>
        ))}
      </div>

      {/* First, above the controls it resets — a re-read changes what every select below offers. */}
      <Form method="get" className="panel-form">
        <div>
          <label htmlFor="header-row">
            Header row
            <select id="header-row" name="header" defaultValue={String(headerRow)}>
              {headerOptions.map((option) => (
                <option key={option.index} value={option.index}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button type="submit" className="button button--quiet">
          Re-read with this header row
        </button>
      </Form>

      {/* File's own words verbatim — no `.is-numeric`, since which columns are numbers is what the screen decides. */}
      <div className="data-table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              {headerCells.map((cell, index) => (
                <th key={index} scope="col">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.map((cells, row) => (
              <tr key={row}>
                {cells.map((cell, column) => (
                  <td key={column}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {problems.length > 0 || actionData?.formError ? (
        <div className="panel-body form-intro">
          {actionData?.formError ? (
            <p className="form-error" role="alert">
              {actionData.formError}
            </p>
          ) : null}
          {problems.map((message, index) => (
            <p key={index} className="field-error" role="alert">
              {message}
            </p>
          ))}
        </div>
      ) : null}

      <Form method="post" className="panel-form">
        <input type="hidden" name="headerRow" value={headerRow} />

        {COLUMN_CONTROLS.map(({ field, caption, optional }) =>
          columnSelect(field, caption, optional),
        )}

        {/* Always rendered — a reveal reacting to another control needs JavaScript. */}
        <fieldset>
          <legend>Cost basis is</legend>
          <label className="choice">
            <input
              type="radio"
              name="costBasisIs"
              value="per_share"
              defaultChecked={values.costBasisIs !== "total"}
            />
            Per share
          </label>
          <label className="choice">
            <input
              type="radio"
              name="costBasisIs"
              value="total"
              defaultChecked={values.costBasisIs === "total"}
            />
            Total for the position
          </label>
          <p className="field-note">Applies only when a cost basis column is mapped.</p>
          {errors?.costBasisIs ? (
            <p className="field-error" role="alert">
              {errors.costBasisIs}
            </p>
          ) : null}
        </fieldset>

        {/* Unticked keeps the file's own sign — how an overdraft records (DESIGN.md §14.8). */}
        <label className="choice">
          <input
            type="checkbox"
            name="owedAsPositive"
            value="true"
            defaultChecked={values.owedAsPositive === "true"}
          />
          This file lists what is owed on {draft.accountName} as a positive number
        </label>

        <button type="submit" className="button">
          Save mapping and continue
        </button>
      </Form>
    </section>
  );
}
