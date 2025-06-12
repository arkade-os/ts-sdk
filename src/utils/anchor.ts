export const ANCHOR_VALUE = 0n;
export const ANCHOR_PKSCRIPT = new Uint8Array([0x51, 0x02, 0x4e, 0x73]);

export const P2A = {
    script: ANCHOR_PKSCRIPT,
    amount: ANCHOR_VALUE,
};
