# Account pickers and file-to-account mapping — how established apps do it

*Researched 2026-08-30, against `5aa2fb2`. Sources listed at the foot; every substantive claim is
attributed and graded. Nothing here is approved work.*

Background for redesigning the upload screen's account dropdown. Today that dropdown renders the
account name and nothing else (`app/routes/upload.tsx:140-143` — the loader deliberately narrows to
`{ id, name }` at `upload.tsx:37`), so a household with two Schwab accounts sees two entries that
differ only if the household happened to name them differently. The two questions investigated:

1. How do established personal-finance and portfolio apps **label accounts** in pickers and lists —
   owner, institution, type, masked last-4, nickname, grouping?
2. In their statement/CSV/PDF import flows, how does an uploaded file **find its account** — manual
   picker, auto-detection from the file, or "open the account first, then import"?

Reads alongside [the upload UX review](./2026-08-25-upload-ux-review.md) (`UX-2`, and `SET-11`'s
wrong note on the account-number field) and [broker header aliases](./2026-08-25-broker-header-aliases.md)
(what a curated per-institution table can and cannot detect). Where a finding here bears on one of
those, it says so in place.

## Method and its limits

Recorded so the findings can be weighed rather than taken flat.

- **Most of the commercial web is egress-blocked from this environment** — `plaid.com`, every
  commercial help center (YNAB, Monarch, Copilot, Empower, Lunch Money, Simplifi, Sharesight,
  Snowball, Schwab, Fidelity, Chase), `nngroup.com`, and `web.archive.org` all refuse at the proxy.
  GitHub is reachable. Two evidence grades are used throughout:
  - **●** — read directly: source code, spec files, or a manual's source repository. The strongest
    material here; quotes are verbatim.
  - **◐** — the owner's own page, reached only through search-result excerpts of it, with the URL.
    The claim is attributable but the surrounding page was not read; quote-level fidelity is not
    guaranteed. Anything only a third-party blog said was discarded, not downgraded.
- **Open-source claims are ●.** Portfolio Performance (code and manual source), Ghostfolio (code),
  Lunch Money's knowledge base (mirrored in `lunch-money/support` on GitHub — the mirror may lag
  the live site: it states a 200kb file cap where the live KB's excerpt says 3Mb, so flow claims
  are taken from it and limits are not), Plaid's OpenAPI spec (`plaid/plaid-openapi`), USWDS
  (`uswds/uswds-site`), Polaris (`Shopify/polaris`), the W3C APG (`w3c/aria-practices`), MDN
  (`mdn/content`).
- **Not verified, and not to be treated as settled:** what a broker's *default* (un-nicknamed)
  account label contains — the "Individual (…1234)" / "Roth Contributory IRA" register is folklore
  supported only by third-party pages, so it is described below via what Schwab's own help does
  verify (nicknames replace the account number in the picker) and via Plaid's mask rules, not
  asserted as a Schwab quote. Monarch's *visual* account-row anatomy (logo, mask placement) was
  also not verifiable from excerpts; only its ownership model is claimed.

## The five answers that matter

1. **The label anatomy converges everywhere it is documented: a person-meaningful name first, the
   institution and type as secondary text, and the masked last-4 as the tiebreaker.** Plaid's
   account object is exactly this decomposition (`name` / `official_name` / `type`+`subtype` /
   `mask`), and Schwab's own help describes nicknames as *replacing the account number* in its
   account picker. Every part already exists in this repo's schema —
   `migrations/0001_initial_schema.sql:32-60` has `name`, `institution`, `kind`, `owner_id`,
   `tax_treatment`, `external_account_number`, and `accounts.server.ts:143-149` already selects
   owner name and institution. The upload dropdown just does not use them.

2. **Where households exist, ownership is an explicit per-account label, not a naming convention.**
   Monarch — the closest mass-market analogue to a multi-person household tracker — attaches an
   owner (a member, or "Shared") to every account, prompts for it when an account is connected,
   offers bulk "Edit Owners" on the accounts list, and lets transactions inherit the account's
   owner. Ghostfolio and Portfolio Performance are single-user-per-file and lean on the
   institution/platform label instead. Nobody surveyed disambiguates by owner *only* through the
   account's free-text name.

3. **No surveyed app auto-detects the target account from identifiers inside the uploaded file.**
   The split is: *pick the account first, then import* (YNAB, Simplifi, Lunch Money, Sharesight,
   Snowball, Monarch's per-account route); *an account column in the file*, matched against the
   user's own account names/ids (Ghostfolio, Monarch's multi-account route); and *detect the bank,
   not the account* (Portfolio Performance's PDF importer — it identifies the broker from the
   statement text, then **remembers which account you imported that broker's documents into last
   time** and preselects it). PP's comment states the design premise outright: "generally one type
   of document (i.e. from the same bank) will be imported into the same account."

4. **Plaid treats the mask as an identity fragment, not a key.** Its spec says the mask "may be
   non-unique between an Item's accounts" and "may also not match the mask that the bank displays
   to the user" — and its bank-facing spec forbids sending `****5820` or `xxxx-5820`, requiring at
   most four bare characters. The rendering convention (`…1234` / `(...1234)`) belongs to the UI,
   the stored value is the bare fragment. That matches this repo's existing
   `external_account_number` free-text column.

5. **At household scale the plain `<select>` is the right control, and grouping is its native
   affordance.** USWDS: a select suits "about seven to 15 possible options", fewer than seven
   suggests radio buttons, more than 15 a combo box. Polaris: use a select from 4+ options and
   preselect a sensible default. `<optgroup>` exists precisely to group options — by owner or by
   institution — inside a native select. Nothing about a four-to-eight-account household justifies
   a combobox.

---

## 1. Plaid — the field set the industry shares

Plaid Link's Account Select pane is the account picker most US finance apps put in front of users,
so its data model is the de-facto label anatomy. From the OpenAPI spec (●, `AccountBase` in
[`plaid/plaid-openapi`](https://github.com/plaid/plaid-openapi), master, `2020-09-14.yml`):

- `name` — "The name of the account, either assigned by the user or by the financial institution
  itself". The user-meaningful label; nickname wins when one exists.
- `official_name` — "The official name of the account as given by the financial institution".
  Kept as a *separate* field from `name` — the product name ("Premier Plus Chk") is not the label.
- `mask` — "The last 2-4 alphanumeric characters of either the account's displayed mask or the
  account's official account number. Note that the mask may be non-unique between an Item's
  accounts."
- `type` / `subtype` — a two-level registration taxonomy (`depository/checking`,
  `investment/roth`, …), the machine-readable version of "what kind of account is this".

The account objects Link hands back on success carry the same four (●, spec
`LinkSessionSuccessMetadataAccount`), with the sharper caveat on `mask`: it "may also not match the
mask that the bank displays to the user."

Pane behavior (◐, [Customizing Link](https://plaid.com/docs/link/customization/) and
[Core Exchange: User experience](https://plaid.com/core-exchange/docs/user-experience/)): the
Account Select pane is where "the user selects which accounts they would like to share"; it is
configurable as one account / multiple accounts / all-preselected, and `account_filters` restricts
which types and subtypes appear at all. For the wealth and payments use cases Plaid recommends the
forced-choice variants — i.e. even the aggregator does not let "which account?" pass undecided.

Two mask rules worth copying (◐, [Core Exchange API reference](https://plaid.com/core-exchange/docs/reference/6.1/)
and [Accounts API](https://plaid.com/docs/api/accounts/)): banks must supply the display number as
at most four bare characters — "5820, not ****5820 or xxxx-5820" — with the ellipsis prefix left to
the renderer; and an app showing a linked account should identify it by the mask rather than by
truncating a real account number itself, because tokenized institutions (Chase among them) hand out
numbers the user has never seen.

## 2. Budgeting and aggregator apps

### Monarch Money — the household case, and two import routes

The one surveyed app whose model matches this repo's "whose account is this" problem.

**Ownership is a first-class account attribute** (◐,
[Shared Views in Monarch](https://help.monarch.com/hc/en-us/articles/42228648365076-Shared-Views-in-Monarch),
[Monarch for Couples and Households](https://help.monarch.com/hc/en-us/articles/20926382202004-Monarch-for-Couples-and-Households)):

- Household members each get their own login with equal visibility.
- When a new account is connected, Monarch **prompts for an owner at connect time**; inviting a
  member triggers a prompt to assign ownership across existing accounts.
- Owners are edited in bulk via "Edit Owners" at the top of the Accounts page, or per-account.
- The label is a member **or "Shared"**; pre-existing accounts default to Shared.
- Transactions inherit their account's owner, overridable per transaction or by rule — ownership
  is the filter Shared Views are built from.

**CSV import has two deliberate routes** (◐,
[Import Transaction History Manually](https://help.monarch.com/hc/en-us/articles/4409682789908-Import-Transaction-History-Manually)):

- *Account-first:* open the account's details page → Edit → import. The file needs no account
  column — the destination is the page you are standing on.
- *File-first:* upload via "+ Add Account", where a file may carry **one or many accounts**; an
  account-name column is then **required**, and rows map to accounts by that name. Column mapping
  is auto-proposed by keyword matching and shown for review; missing or duplicated required
  headers block the import with a prompt to fix the file.
- Balance-history import is narrower: one account per file, from that account's own page (◐,
  [Importing Account Balances Manually](https://help.monarch.com/hc/en-us/articles/14882425704212-Importing-Account-Balances-Manually)).

So Monarch's answer to "map a multi-account file" is a *user-authored* account-name column — a
join on the user's own labels, not on broker identifiers.

### YNAB — open the account, then import

File-based import is "download a file of transactions from your bank and drag and drop it into
YNAB" (◐, [File-Based Import in YNAB](https://support.ynab.com/en_us/file-based-import-a-guide-Bkj4Sszyo));
the import entry point is the account itself — click the account in the sidebar, then Import in
its register (◐, synthesized across
[Adding Transactions Without Direct Import](https://support.ynab.com/en_us/adding-transactions-without-direct-import-B1kBALVaxx)
and [How to Add Transactions](https://support.ynab.com/en_us/how-to-add-transactions-in-ynab-HyDwA_byi);
the excerpts state the sidebar-then-Import sequence but the guide page could not be read whole).
There is no account column in its CSV spec (◐,
[Formatting a CSV File](https://support.ynab.com/en_us/formatting-a-csv-file-an-overview-BJvczkuRq))
— the file never says which account, the register does.

### Lunch Money — pick the asset first, and the mapping is remembered per asset

● — the KB is public in [`lunch-money/support`](https://github.com/lunch-money/support/blob/master/importing-transactions/import-via-csv.md)
(live page: [support.lunchmoney.app/guides/import-via-csv](https://support.lunchmoney.app/guides/import-via-csv)):

> "The first step is to select the manually-managed asset that you'll be importing your
> transactions into."

and, after column mapping:

> "Finally, you can choose to save your configuration. We will then remember your settings
> whenever you upload CSV files for this asset and you can skip steps 2 and 3!"

Account choice is step 1 of the wizard; the saved mapping is keyed to the account. This is the
closest published analogue to this repo's remembered per-institution mapping
(`rememberMapping`, `app/lib/uploads.server.ts:354`), except Lunch Money keys by *asset* where
this repo keys by *institution*.

### Quicken Simplifi — open the account, then import

◐, [How to Manually Import Transactions](https://support.simplifi.quicken.com/en/articles/4413430-how-to-manually-import-transactions):
"Transactions can only be imported into one account at a time" — the documented flow is
Transactions → choose the account → the Import icon → drop the file → review the summary → Import.
Web app only; a given file imports once.

### Copilot Money — declined file import altogether

◐ — Copilot's help center states it does not support importing transactions via CSV/XLS
([Historical Transaction Data](https://help.copilot.money/en/articles/5542003-historical-transaction-data),
[Investment Account Limitations](https://help.copilot.money/en/articles/10262766-investment-account-limitations));
data arrives by aggregator or by hand into manual accounts. Its *export* schema is still
instructive: among the columns are "Account **and Account Mask**" (◐,
[Exporting Your Transaction Data](https://help.copilot.money/en/articles/5944414-exporting-your-transaction-data))
— even an app with no import flow treats name-plus-mask as the account's identity pair.

### Empower (Personal Capital) — aggregation-only, nicknames for same-institution collisions

◐ — no file import of transactions exists, and no Mint migration path
([Can I Import My Data from Mint?](https://support-personalwealth.empower.com/hc/en-us/articles/19048263355287-Can-I-Import-My-Data-from-Mint));
manual accounts are updated by hand. Two labeling points from its own help:

- [Change Your Account Name](https://support-personalwealth.empower.com/hc/en-us/articles/201169840-Change-Your-Account-Name):
  renaming exists explicitly so you can "customize account names if you have multiple accounts
  from the same financial institution" — the exact failure this research is about, solved there
  by nickname.
- [Accounts Panel Overview](https://support-personalwealth.empower.com/hc/en-us/articles/201169750-Accounts-Panel-Overview):
  the sidebar groups accounts under ASSETS and LIABILITIES sections; selecting one shows
  institution name, account name, and balance.

## 3. Portfolio trackers with file import — the closest analogues

### Portfolio Performance — detect the bank, remember the account

The reported "auto-detects the broker and targets the right account" behavior decomposes, in
source, into two distinct mechanisms — and the second is memory, not detection.

**Detection identifies the bank, never the account** (●,
[`PDFImportAssistant.java`](https://github.com/portfolio-performance/portfolio/blob/master/name.abuchen.portfolio/src/name/abuchen/portfolio/datatransfer/pdf/PDFImportAssistant.java)):
`run()` converts each PDF to text and offers it to every registered per-institution extractor
(`DeutscheBankPDFExtractor`, `Trading212PDFExtractor`, `WealthsimpleInvestmentsIncPDFExtractor`, …)
in sequence; the first extractor that yields items claims the file, with a legacy-PDFBox re-parse
as fallback. An extractor claims a document by substring: each registers bank-identifier strings,
and a document containing none of them is rejected (●,
[`AbstractPDFExtractor.java`](https://github.com/portfolio-performance/portfolio/blob/master/name.abuchen.portfolio/src/name/abuchen/portfolio/datatransfer/pdf/AbstractPDFExtractor.java),
`addBankIdentifier` / the check around line 203). The user manual states the user-visible
consequence: "The import wizard will either recognise it automatically or display an error message
listing all the banks/brokers it has tried" (●, manual source
[`pdf-import.md`](https://github.com/portfolio-performance/portfolio-help/blob/main/docs/en/reference/file/import/pdf-import.md),
published at [help.portfolio-performance.info](https://help.portfolio-performance.info/en/reference/file/import/pdf-import/);
the manual claims support for "more than 90 banks and brokers").

**The target account is chosen in the review wizard — combo boxes with a three-tier preselect**
(●, [`ReviewExtractedItemsPage.java`](https://github.com/portfolio-performance/portfolio/blob/master/name.abuchen.portfolio.ui/src/name/abuchen/portfolio/ui/wizards/datatransfer/ReviewExtractedItemsPage.java)):

> `// idea: generally one type of document (i.e. from the same bank) will`
> `// be imported into the same account`

- One read-only combo per **currency** appearing in the file for the cash account (accounts
  filtered to that currency, active first, sorted by name — a missing currency renders a "create
  an account first" message instead of a dropdown), plus a combo for the securities account.
- `preselectDropDowns()` picks, in order: (1) the account the dialog was opened *from*, if its
  currency matches; (2) the account used the **last time this same bank's documents were
  imported** — a preference keyed `IMPORT_TARGET_ACCOUNT + extractor.getLabel() + currency`
  (currency added to the key in May 2025, with a legacy fallback); (3) the first account. The
  choice is written back on finish, so the memory is per-institution and self-maintaining.
- The manual's worked example shows the failure mode the wizard surfaces rather than hides: a
  EUR cash account preselected for an AUD transaction produces an error at the bottom of the
  dialog until an AUD account is selected or created (●, `pdf-import.md`).

So PP's flow is: *no* account question when the memory answers it, an editable dropdown when it
does not — auto-detection narrows to the institution, and habit does the rest.

### Ghostfolio — an account column in the file, matched by name or id

The import dialog has **no account picker at all** (●,
[`import-activities-dialog`](https://github.com/ghostfolio/ghostfolio/tree/main/apps/client/src/app/pages/portfolio/activities/import-activities-dialog)
— a stepper of file-select then a preview table with per-row checkboxes). The account comes from
the file (●, [`import-activities.service.ts`](https://github.com/ghostfolio/ghostfolio/blob/main/apps/client/src/app/services/import-activities.service.ts)):

```ts
private static ACCOUNT_KEYS = ['account', 'accountid'];
// parseAccount:
return userAccounts.find(({ id, name }) => {
  return (
    id === value || name?.toLowerCase() === String(value).toLowerCase()
  );
})?.id;
```

A row's `account`/`accountid` cell is matched against the user's accounts **by id or
case-insensitive name**; no match (or no column) yields `undefined` and the activity imports with
no account — there is no fallback picker. Round-tripping works because the export writes
`accountId` on every activity (●,
[`export.service.ts`](https://github.com/ghostfolio/ghostfolio/blob/main/apps/api/src/app/export/export.service.ts)).

Where Ghostfolio *does* render an account picker (creating or editing an activity), the option
anatomy is exactly the convergent one (●,
[`account-selector`](https://github.com/ghostfolio/ghostfolio/blob/main/libs/ui/src/lib/account-selector/account-selector.component.html)):
a platform (institution) logo, then `{{ account.name }}`, then muted small text
`{{ account.platform?.name }} · {{ account.currency }}` — alphabetically sorted, no balance. No
owner appears because a Ghostfolio user's accounts are all their own.

### Sharesight — open the portfolio, then import; the importer maps columns, not accounts

The file importer is entered from a portfolio, and its wizard is about *columns and trades*, never
about picking a destination: "From your portfolio, click Add investment. Select Upload via a file"
(◐, [AI file importer blog](https://www.sharesight.com/blog/ai-file-importer/) — first-party — and
[AI importer help](https://help.sharesight.com/ai-importer/); the older
[bulk trade importer](https://help.sharesight.com/import_bulk_trades/) documents the
column-selection page with auto-suggested field matches, a review list, then "Go to Portfolio").
The AI importer accepts "CSV, PDF, screenshot, or image" and maps the trade data for review — file
format is detected, the destination portfolio never is.

### Snowball Analytics — one portfolio per brokerage account, so the question disappears

◐, [Getting Started](https://help.snowball-analytics.com/welcome/): a first portfolio is created
at registration, and "when you need to add a second brokerage account, click on your current
portfolio name on the top panel, then on the 'Add portfolio' button" — the structure is one
portfolio per real account. Imports ("plus sign on the top panel → Import a spreadsheet", with
per-broker export guides and a [custom CSV template](https://help.snowball-analytics.com/import-custom/))
land in the portfolio you are standing in. Disambiguation is done by *navigation context*, the
statement-upload equivalent of "open the account first".

## 4. Brokers' own pickers

What the surveyed help centers actually verify about the "Nickname (…1234)" convention:

- **Schwab** (◐, [StreetSmart help — Accounts Customization](https://help.streetsmart.schwab.com/Com/3.50/Content/Accounts_Settings.htm)):
  "Account nicknames are an optional feature used to replace **account number** in the Select
  Account pull-down menu" — i.e. Schwab's own picker identifies accounts by number until a
  nickname substitutes for it. Nicknames are set from Profile → Account Groups (◐,
  [How to rename an account](https://www.schwab.com/resource/how-to-rename-an-account)).
- **Fidelity** (◐, [Account Groups and Nicknames](https://www.fidelity.com/products/atbt/help/ActiveTraderTools_AccountGroups_Help.html)):
  a "Name Accounts and Customize Display" page creates and edits **groups and account nicknames**,
  and those carry across surfaces (into Active Trader Pro) — nicknaming and grouping are one
  feature, and the label is expected to be consistent everywhere the account appears.
- **White-label banking platforms** ship the same convention as a product feature: Oracle's
  Banking Digital Experience documents per-account customer-assigned nicknames as a standard
  capability (◐, [OBDX "Account Nickname"](https://docs.oracle.com/en/industries/financial-services/banking-digital-experience/25.1.1.0.0/fxcra/account-nickname.html)).
- The **registration-type element** of the folklore label ("Individual", "Joint Tenant", "Roth
  Contributory IRA" as the default name) could not be verified against any first-party page from
  here and is deliberately not asserted — see Method. What stands instead: Plaid's `type`/`subtype`
  taxonomy is the machine form of the same information, and Plaid's guidance is to show mask, not
  number.

## 5. Component-level guidance (short)

- **USWDS** (●, guidance source in [`uswds/uswds-site`](https://github.com/uswds/uswds-site/tree/main/_components),
  published at [designsystem.digital.gov/components/select](https://designsystem.digital.gov/components/select/)
  and [/components/combo-box](https://designsystem.digital.gov/components/combo-box/)): use a
  select "only when a user needs to choose from about seven to 15 possible options"; "Fewer than
  seven options. Use radio buttons instead."; "Use a combo box when there are more than 15 choices
  in a drop-down list." Plus: pick a good default, and never auto-submit on change.
- **Polaris** (●, [`select.mdx`](https://github.com/Shopify/polaris/blob/main/polaris.shopify.com/content/components/selection-and-input/select.mdx)):
  a select is for "4 or more pre-defined options", should "have a default option selected whenever
  possible", and "Select" as placeholder only when no logical default exists.
- **`<optgroup>`** (●, [MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/optgroup),
  source in `mdn/content`): "creates a grouping of options within a `<select>` element" — the
  native, zero-JS way to group a picker by owner or institution.
- **NN/g** (◐, [Dropdowns: Design Guidelines](https://www.nngroup.com/articles/drop-down-menus/),
  [Does Your Form Really Need a Dropdown List?](https://www.nngroup.com/articles/dropdown-list/),
  [Listboxes vs. Dropdown Lists](https://www.nngroup.com/articles/listbox-dropdown/)): dropdowns
  get overwhelming past roughly 15 options, typing beats scrolling for values the user already
  knows, and design systems draw the "too few for a dropdown" line even lower (the article cites
  Material at 6, Carbon at 3).
- **W3C APG** (●, [combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/), source
  in `w3c/aria-practices`): the combobox is defined as an *input* with an associated popup of
  allowed or suggested values — a typing-first control, which is why the guidance above reserves
  it for lists long enough that typing wins.

For a household of two people and a handful of accounts each, the numbers land squarely on a
grouped native select: too many for radios only at the top end, nowhere near combobox territory.

## 6. Synthesis

### The recurring label anatomy

Across every surface where the parts are documented, the order is stable:

| Position | Part | Who verifiably shows/stores it |
|---|---|---|
| 1 | Person-meaningful name (nickname wins over product name) | Plaid `name` vs `official_name`; Schwab (nickname replaces number); Fidelity; Empower |
| 2 | Institution, often as logo | Ghostfolio (platform logo + name); Empower (institution on summary); Plaid Link (institution-scoped panes) |
| 3 | Type / registration | Plaid `type`+`subtype`; Ghostfolio shows currency in this slot instead |
| 4 | Masked last-4, rendered `…1234`, stored bare | Plaid `mask` (+ Core Exchange bare-4 rule); Copilot export "Account and Account Mask" |
| — | Owner tag, where households exist | Monarch (member or "Shared", on the account) |
| — | Grouping of the list | Empower (assets/liabilities); Fidelity (account groups); Monarch (Edit Owners operates on the grouped list) |

The mask is a *tiebreaker*, explicitly allowed to collide (Plaid) — it supplements the name, it
never replaces it. Owner, where it exists, is a structured label used for filtering and defaults,
not a prefix crammed into the name — though the nickname convention ("John's IRA") is how
single-owner brokers let households fake it.

### Mapping a file to an account — three strategies, one absence

| Strategy | Who | Trade-off chosen |
|---|---|---|
| Account first, then file (context is the answer) | YNAB, Simplifi, Lunch Money, Sharesight, Snowball, Monarch (route A) | Zero mapping ambiguity, one extra navigation step per statement; multi-account files impossible |
| Account column in the file, matched to the user's own labels | Ghostfolio (`account`/`accountid`, by id or name), Monarch (route B, account-name column required) | Multi-account files work; user must author/maintain the column; unmatched rows fall through (Ghostfolio: imported accountless, silently) |
| Detect the institution from content, remember the account per institution | Portfolio Performance | No question asked in the steady state; wrong preselect is *shown* in an editable dropdown, and currency mismatch is a blocking, named error |
| Detect the *account* from numbers inside the file | **nobody surveyed** | — |

The absence is the finding. Even Portfolio Performance, with a per-broker parser for each
supported institution, does not fish an account number out of the statement to pick the target —
it detects the *bank* and lets the user's own history answer the *account*. Copilot and Empower
sit outside the table having declined file import entirely (aggregator-only), which is the one
strategy unavailable to a self-hosted tracker.

### What this maps onto in this repo

Stated as observations, not a spec:

- Every anatomy part in §6's table already exists on `account`
  (`migrations/0001_initial_schema.sql:32-60`: `name`, `institution`, `kind`, `owner_id` →
  `person.name`, `tax_treatment`, `external_account_number`) and most are already selected by
  `listAccounts` (`app/lib/accounts.server.ts:143-149`). The upload loader narrows them away
  (`app/routes/upload.tsx:37`); the dropdown's poverty is a projection choice, not a data gap.
- The convergent option label for this app would read: **name — owner, kind, (…last-4 of
  `external_account_number`)**, optionally grouped by owner or institution with `<optgroup>`.
  One owner per account is already the design (`0001_initial_schema.sql:32`, ADR-0008's
  `OwnerFilter` posture), which is Monarch's model minus "Shared".
- Portfolio Performance's preselect memory is the same mechanism as this repo's remembered
  per-institution column mapping (`rememberMapping`, `app/lib/uploads.server.ts:354`) — extended
  from "which columns" to "which account". Lunch Money's per-asset saved configuration is the same idea keyed the other way.
  The precedent for `SET-11`'s aspirational note (the account-number field claiming to preselect
  the account) is *not* supported by any surveyed app: nobody matches file content to an account;
  the two proven preselects are "last time" and "the page you came from".
- Sharesight's AI importer and PP's extractor list both put institution detection *before* column
  mapping, which is the ordering the [broker header aliases](./2026-08-25-broker-header-aliases.md)
  proposal already argues for — nothing found here contradicts that document; PP's
  identifier-substring matching (exact registered strings, not fuzzy) supports its anti-fuzzing
  stance.

## Sources

Read directly (●):

- Plaid OpenAPI spec — https://github.com/plaid/plaid-openapi (master, `2020-09-14.yml`;
  `AccountBase`, `LinkSessionSuccessMetadataAccount`)
- Portfolio Performance — https://github.com/portfolio-performance/portfolio :
  `name.abuchen.portfolio/src/name/abuchen/portfolio/datatransfer/pdf/PDFImportAssistant.java`,
  `.../pdf/AbstractPDFExtractor.java`,
  `name.abuchen.portfolio.ui/src/name/abuchen/portfolio/ui/wizards/datatransfer/ReviewExtractedItemsPage.java`
- Portfolio Performance manual source — https://github.com/portfolio-performance/portfolio-help
  (`docs/en/reference/file/import/pdf-import.md`), published at
  https://help.portfolio-performance.info/en/reference/file/import/pdf-import/
- Ghostfolio — https://github.com/ghostfolio/ghostfolio :
  `apps/client/src/app/services/import-activities.service.ts`,
  `apps/client/src/app/pages/portfolio/activities/import-activities-dialog/`,
  `libs/ui/src/lib/account-selector/`, `apps/api/src/app/export/export.service.ts`
- Lunch Money KB mirror — https://github.com/lunch-money/support
  (`importing-transactions/import-via-csv.md`), published at
  https://support.lunchmoney.app/guides/import-via-csv
- USWDS guidance source — https://github.com/uswds/uswds-site
  (`_components/select/guidance/`, `_components/combo-box/guidance/`), published at
  https://designsystem.digital.gov/components/select/ and /components/combo-box/
- Polaris — https://github.com/Shopify/polaris
  (`polaris.shopify.com/content/components/selection-and-input/select.mdx`)
- W3C APG combobox pattern source — https://github.com/w3c/aria-practices
  (`content/patterns/combobox/combobox-pattern.html`)
- MDN `<optgroup>` source — https://github.com/mdn/content
  (`files/en-us/web/html/reference/elements/optgroup/index.md`)

Owner's page via search excerpt (◐):

- Plaid docs — https://plaid.com/docs/link/customization/ ,
  https://plaid.com/core-exchange/docs/user-experience/ ,
  https://plaid.com/core-exchange/docs/reference/6.1/ , https://plaid.com/docs/api/accounts/
- Monarch — https://help.monarch.com/hc/en-us/articles/42228648365076-Shared-Views-in-Monarch ,
  https://help.monarch.com/hc/en-us/articles/20926382202004-Monarch-for-Couples-and-Households ,
  https://help.monarch.com/hc/en-us/articles/4409682789908-Import-Transaction-History-Manually ,
  https://help.monarch.com/hc/en-us/articles/14882425704212-Importing-Account-Balances-Manually
- YNAB — https://support.ynab.com/en_us/file-based-import-a-guide-Bkj4Sszyo ,
  https://support.ynab.com/en_us/formatting-a-csv-file-an-overview-BJvczkuRq ,
  https://support.ynab.com/en_us/adding-transactions-without-direct-import-B1kBALVaxx
- Copilot — https://help.copilot.money/en/articles/5542003-historical-transaction-data ,
  https://help.copilot.money/en/articles/10262766-investment-account-limitations ,
  https://help.copilot.money/en/articles/5944414-exporting-your-transaction-data
- Empower — https://support-personalwealth.empower.com/hc/en-us/articles/201169840-Change-Your-Account-Name ,
  .../201169750-Accounts-Panel-Overview , .../19048263355287-Can-I-Import-My-Data-from-Mint
- Simplifi — https://support.simplifi.quicken.com/en/articles/4413430-how-to-manually-import-transactions
- Sharesight — https://help.sharesight.com/import_bulk_trades/ ,
  https://help.sharesight.com/ai-importer/ , https://www.sharesight.com/blog/ai-file-importer/
- Snowball Analytics — https://help.snowball-analytics.com/welcome/ ,
  https://help.snowball-analytics.com/import-custom/
- Schwab — https://help.streetsmart.schwab.com/Com/3.50/Content/Accounts_Settings.htm ,
  https://www.schwab.com/resource/how-to-rename-an-account
- Fidelity — https://www.fidelity.com/products/atbt/help/ActiveTraderTools_AccountGroups_Help.html
- Oracle OBDX — https://docs.oracle.com/en/industries/financial-services/banking-digital-experience/25.1.1.0.0/fxcra/account-nickname.html
- NN/g — https://www.nngroup.com/articles/drop-down-menus/ ,
  https://www.nngroup.com/articles/dropdown-list/ , https://www.nngroup.com/articles/listbox-dropdown/
