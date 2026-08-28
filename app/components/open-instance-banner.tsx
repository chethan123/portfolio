/**
 * The persistent "nothing is guarding this" warning.
 *
 * Rendered on every page whenever the app has not been told a gate fronts it
 * (`AUTH_GATE`), and deliberately not dismissible: an open instance is a state
 * to be noticed every time, not an alert to be acknowledged once and then
 * forgotten. Which is also why it must never appear behind the gate — a warning
 * that is wrong on a protected instance is a warning the family stops reading
 * on an unprotected one.
 *
 * It names no variable, and that is deliberate too. `AUTH_GATE=external` is the
 * app describing its deployment, not a switch that protects anything, so a
 * banner offering it as the fix would be teaching the one mistake that silences
 * the warning while leaving the instance wide open. The fix is a gate in front,
 * which is a deploy-time act; the banner points at the state, not the setting.
 *
 * The sentence is one element rather than a run of loose text around
 * `<strong>`: the banner is a flex row, and loose text nodes would each become
 * a flex item with the row's gap opened between them.
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
