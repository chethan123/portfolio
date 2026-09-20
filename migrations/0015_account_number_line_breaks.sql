-- Line breaks out of numbers captured before statement.ts stripped them (#312). A quoted CSV cell
-- may hold a CR or an LF, and an upload used to write one straight onto the account. Such a row
-- cannot be saved from the settings form at all -- the box drops the break, the parser folds the
-- CR, and the compare-and-set predicate matches neither value -- and uploads.server.ts refuses the
-- account's own next statement, since the file's cell is now canonicalised and the column is not.
-- Same rule as the parser's, so both sides of that check read one spelling again.
update account
set external_account_number = translate(external_account_number, E'\r\n', '')
where external_account_number ~ E'[\r\n]';
