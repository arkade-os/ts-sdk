/** Greatest common divisor of two bigints (Euclidean algorithm). */
export function gcd(a: bigint, b: bigint): bigint {
    a = a < 0n ? -a : a;
    b = b < 0n ? -b : b;
    while (b > 0n) {
        [a, b] = [b, a % b];
    }
    return a;
}
