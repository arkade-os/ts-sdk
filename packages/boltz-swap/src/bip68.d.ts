declare module "bip68" {
    export function encode(
        opts:
            | { blocks: number; seconds?: never }
            | { blocks?: never; seconds: number }
    ): number;

    export function decode(seq: number): {
        blocks?: number;
        seconds?: number;
    };
}
