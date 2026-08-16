import { StubPage } from "~/components/stub-page";

export function meta() {
  return [{ title: "Overview · Portfolio" }];
}

export default function Overview() {
  return (
    <StubPage title="Overview">
      Net worth, the trend line and the allocation breakdown will live here. There is no data
      yet — this instance has no schema and nothing has been uploaded.
    </StubPage>
  );
}
