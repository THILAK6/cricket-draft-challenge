/** One place for overs notation: 2 overs and 4 balls is "2.4", never the decimal 2.67. */
export const ballsToOvers = (balls: number): string => `${Math.floor(balls / 6)}.${balls % 6}`;

/** "2.4" -> 16 balls. */
export const oversToBalls = (o: string): number => {
  const [w, b] = o.split(".").map(Number);
  return (w || 0) * 6 + (b || 0);
};

/** A decimal number of overs (e.g. 2.667) -> "2.4". */
export const decimalOversToString = (overs: number): string => ballsToOvers(Math.round(overs * 6));
