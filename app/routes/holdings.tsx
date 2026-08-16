import { StubPage } from "~/components/stub-page";

export function meta() {
  return [{ title: "Holdings · Portfolio" }];
}

export default function Holdings() {
  return (
    <StubPage title="Holdings">
      Every position across every account, grouped and filterable. There is no data yet.
    </StubPage>
  );
}
