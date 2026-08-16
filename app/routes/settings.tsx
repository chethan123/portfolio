import { StubPage } from "~/components/stub-page";

export function meta() {
  return [{ title: "Settings · Portfolio" }];
}

export default function Settings() {
  return (
    <StubPage title="Settings">
      People, accounts, classifications, instruments and history. The People and Accounts tabs
      are built in a later slice.
    </StubPage>
  );
}
