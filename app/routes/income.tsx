import { StubPage } from "~/components/stub-page";

export function meta() {
  return [{ title: "Income · Portfolio" }];
}

export default function Income() {
  return (
    <StubPage title="Income">
      Dividend and interest income over time. There is no data yet.
    </StubPage>
  );
}
