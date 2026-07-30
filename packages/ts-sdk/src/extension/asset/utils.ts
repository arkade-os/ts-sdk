export function isZeroBytes(bytes: Uint8Array): boolean {
    return bytes.every((byte) => byte === 0);
}
