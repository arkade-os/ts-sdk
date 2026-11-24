/** Whether the package's own claim packets bind `min_amount`. Off until covclaimd with
 * `min_amount` support is deployed: an older one cannot open a bound packet. Internal: never
 * re-export it. */
export const bindsClaimAmount = (): boolean => false;
