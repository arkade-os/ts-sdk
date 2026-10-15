export const SWAP_ROOT: string;
export const ROOT_ENTRY: string;
export const CLIENT_ENTRY: string;
export const PROTOCOL_ENTRY: string;
export const ADVANCED_ENTRY: string;
export function inventory(entry: string): {
    name: string;
    kind: "type" | "value";
    module: string;
}[];
