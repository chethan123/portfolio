import { StubPage } from "~/components/stub-page";

export function meta() {
  return [{ title: "Upload · Portfolio" }];
}

export default function Upload() {
  return (
    <StubPage title="Upload">
      Drop a brokerage statement CSV here to map its columns and preview the changes before they
      are applied. The ingest slice builds this.
    </StubPage>
  );
}
