/**
 * Where a seat sits on the ring across the play surface, as CSS percentages of
 * the surface. Index 0 is bottom centre — the viewer at the table, or seat 0 in
 * the room — and the rest run clockwise from there, so the arrangement holds for
 * any table size (3-6 players depending on the plugin).
 *
 * The surface is a plain textured rectangle rather than a drawn oval, so the
 * ring can spread wider than a painted table edge would have allowed. Shared by
 * the room and the table so a seat doesn't appear to move when the match starts.
 */
export function seatPosition(index: number, total: number): { top: string; left: string } {
  const angle = Math.PI / 2 + (index / total) * Math.PI * 2;
  return { top: `${50 + Math.sin(angle) * 34}%`, left: `${50 + Math.cos(angle) * 37}%` };
}
