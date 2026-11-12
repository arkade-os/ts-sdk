/** Whether the package's own claim packets bind `min_amount`. Off until executor's template
 * reads the amount. Internal: never re-export it. */
export const bindsClaimAmount = (): boolean => false;
