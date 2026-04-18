/**
 * ExtensionPacket is the interface that all extension packets must implement.
 * It mirrors the Go extension.Packet interface.
 */
export interface ExtensionPacket {
    /** type returns the 1-byte packet type tag */
    type(): number;
    /** serialize returns the raw bytes of the packet (without type or length prefix) */
    serialize(): Uint8Array;
}

/**
 * UnknownPacket holds a packet whose type is not recognized by this implementation.
 * It round-trips opaquely: the raw bytes are preserved as-is.
 */
export class UnknownPacket implements ExtensionPacket {
    constructor(
        private readonly packetType: number,
        private readonly data: Uint8Array
    ) {}

    type(): number {
        return this.packetType;
    }

    serialize(): Uint8Array {
        return this.data;
    }
}
