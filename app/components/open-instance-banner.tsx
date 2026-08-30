/**
 * The persistent "nothing is guarding this" warning — every page, whenever
 * no gate fronts the app (`AUTH_GATE`), and deliberately not dismissible: an
 * open instance is a state to notice every time. It must never appear behind
 * the gate — a warning wrong on a protected instance is one the family stops
 * reading on an unprotected one.
 *
 * It names no variable, also deliberately: `AUTH_GATE=external` is the app
 * describing its deployment, not a switch that protects anything, and a
 * banner offering it as the fix would teach the one mistake that silences
 * the warning while leaving the instance wide open. The fix is a gate in
 * front — a deploy-time act; the banner points at the state, not a setting.
 *
 * One element, not loose text around `<strong>`: the banner is a flex row,
 * and loose text nodes each become an item with the row's gap between them.
 */
export function OpenInstanceBanner() {
  return (
    <aside className="open-instance-banner" role="status">
      <span>
        <strong>Nothing stands in front of this instance.</strong> No sign-in is being asked
        for, so anyone who can reach it on the network can read and change your data. Put it
        behind the gate before leaving it running anywhere shared.
      </span>
    </aside>
  );
}
