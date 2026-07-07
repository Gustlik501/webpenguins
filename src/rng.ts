/** Random integer in [0, max), like xpenguins' RandInt macro. */
export function randInt(max: number): number {
  return Math.floor(Math.random() * max);
}
