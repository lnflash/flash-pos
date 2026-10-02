/**
 * Greedy power-of-two decomposition (4 → [4]; 6 → [4,2]; 7 → [4,2,1]),
 * largest first. The mint mints change in exactly these pieces and the card
 * receives them in this order, so the charge screen animates one slip per
 * piece from the same function.
 */
export function splitPow2(amountSat: number): number[] {
  const pieces: number[] = [];
  let remaining = amountSat;
  let denom = 1;
  while (denom * 2 <= remaining) {
    denom *= 2;
  }
  while (remaining > 0) {
    if (denom <= remaining) {
      pieces.push(denom);
      remaining -= denom;
    } else {
      denom = Math.floor(denom / 2);
    }
  }
  return pieces;
}
