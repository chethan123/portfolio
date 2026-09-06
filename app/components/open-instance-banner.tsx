// Not dismissible — an open instance (no `AUTH_GATE`) is a state to notice every time. Names no variable: the fix is a gate in front, not a setting.
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
