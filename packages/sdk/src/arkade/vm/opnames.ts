// Imports nothing, so limits.ts can name opcodes without joining the opcodes.ts <-> ops/* graph.
export const OPCODE_FAMILIES = {
    core: {
        OP_NOP: 0x61,
        OP_IF: 0x63,
        OP_NOTIF: 0x64,
        OP_ELSE: 0x67,
        OP_ENDIF: 0x68,
        OP_VERIFY: 0x69,
        OP_RETURN: 0x6a,
        OP_TOALTSTACK: 0x6b,
        OP_FROMALTSTACK: 0x6c,
        OP_2DROP: 0x6d,
        OP_2DUP: 0x6e,
        OP_3DUP: 0x6f,
        OP_2OVER: 0x70,
        OP_2ROT: 0x71,
        OP_2SWAP: 0x72,
        OP_IFDUP: 0x73,
        OP_DEPTH: 0x74,
        OP_DROP: 0x75,
        OP_DUP: 0x76,
        OP_NIP: 0x77,
        OP_OVER: 0x78,
        OP_PICK: 0x79,
        OP_ROLL: 0x7a,
        OP_ROT: 0x7b,
        OP_SWAP: 0x7c,
        OP_TUCK: 0x7d,
        OP_CAT: 0x7e,
        OP_SUBSTR: 0x7f,
        OP_LEFT: 0x80,
        OP_RIGHT: 0x81,
        OP_SIZE: 0x82,
        OP_INVERT: 0x83,
        OP_AND: 0x84,
        OP_OR: 0x85,
        OP_XOR: 0x86,
        OP_EQUAL: 0x87,
        OP_EQUALVERIFY: 0x88,
        OP_NOP1: 0xb0,
        OP_NOP5: 0xb4,
        OP_NOP6: 0xb5,
        OP_NOP7: 0xb6,
        OP_NOP8: 0xb7,
        OP_NOP9: 0xb8,
        OP_NOP10: 0xb9,
        OP_PUT: 0xbb,
    },
    arith: {
        OP_1ADD: 0x8b,
        OP_1SUB: 0x8c,
        OP_2MUL: 0x8d,
        OP_2DIV: 0x8e,
        OP_NEGATE: 0x8f,
        OP_ABS: 0x90,
        OP_NOT: 0x91,
        OP_0NOTEQUAL: 0x92,
        OP_ADD: 0x93,
        OP_SUB: 0x94,
        OP_MUL: 0x95,
        OP_DIV: 0x96,
        OP_MOD: 0x97,
        OP_LSHIFT: 0x98,
        OP_RSHIFT: 0x99,
        OP_BOOLAND: 0x9a,
        OP_BOOLOR: 0x9b,
        OP_NUMEQUAL: 0x9c,
        OP_NUMEQUALVERIFY: 0x9d,
        OP_NUMNOTEQUAL: 0x9e,
        OP_LESSTHAN: 0x9f,
        OP_GREATERTHAN: 0xa0,
        OP_LESSTHANOREQUAL: 0xa1,
        OP_GREATERTHANOREQUAL: 0xa2,
        OP_MIN: 0xa3,
        OP_MAX: 0xa4,
        OP_WITHIN: 0xa5,
        OP_NUM2BIN: 0xd7,
        OP_BIN2NUM: 0xd8,
        OP_REVERSEBYTES: 0xd9,
        OP_MODEXP: 0xda,
    },
    hashops: {
        OP_RIPEMD160: 0xa6,
        OP_SHA1: 0xa7,
        OP_SHA256: 0xa8,
        OP_HASH160: 0xa9,
        OP_HASH256: 0xaa,
        OP_MERKLEBRANCHROOT: 0xb3,
        OP_DIGEST: 0xc3,
        OP_SHA256INITIALIZE: 0xc4,
        OP_SHA256UPDATE: 0xc5,
        OP_SHA256FINALIZE: 0xc6,
    },
    introspect: {
        OP_INSPECTINPUTOUTPOINT: 0xc7,
        OP_INSPECTINPUTARKADESCRIPTHASH: 0xc8,
        OP_INSPECTINPUTVALUE: 0xc9,
        OP_INSPECTINPUTSCRIPTPUBKEY: 0xca,
        OP_INSPECTINPUTSEQUENCE: 0xcb,
        OP_PUSHCURRENTINPUTINDEX: 0xcd,
        OP_INSPECTINPUTARKADEWITNESSHASH: 0xce,
        OP_INSPECTOUTPUTVALUE: 0xcf,
        OP_INSPECTOUTPUTSCRIPTPUBKEY: 0xd1,
        OP_INSPECTVERSION: 0xd2,
        OP_INSPECTLOCKTIME: 0xd3,
        OP_INSPECTNUMINPUTS: 0xd4,
        OP_INSPECTNUMOUTPUTS: 0xd5,
        OP_TXWEIGHT: 0xd6,
        OP_TXID: 0xf3,
    },
    time: {
        OP_CHECKLOCKTIMEVERIFY: 0xb1,
        OP_CHECKSEQUENCEVERIFY: 0xb2,
        OP_PUSHEXPIRY: 0xdb,
        OP_CHECKTIME: 0xdc,
    },
    sig: {
        OP_CODESEPARATOR: 0xab,
        OP_CHECKSIG: 0xac,
        OP_CHECKSIGVERIFY: 0xad,
        OP_CHECKMULTISIG: 0xae,
        OP_CHECKMULTISIGVERIFY: 0xaf,
        OP_CHECKSIGADD: 0xba,
        OP_CHECKSIGFROMSTACK: 0xcc,
        OP_SIGHASH: 0xf6,
    },
    ecops: {
        OP_ECADD: 0xe0,
        OP_ECMUL: 0xe1,
        OP_ECPAIRING: 0xe2,
        OP_ECMULSCALARVERIFY: 0xe3,
        OP_TWEAKVERIFY: 0xe4,
    },
    assets: {
        OP_INSPECTNUMASSETGROUPS: 0xe5,
        OP_INSPECTASSETGROUPASSETID: 0xe6,
        OP_INSPECTASSETGROUPCTRL: 0xe7,
        OP_FINDASSETGROUPBYASSETID: 0xe8,
        OP_INSPECTASSETGROUPMETADATAHASH: 0xe9,
        OP_INSPECTASSETGROUPNUM: 0xea,
        OP_INSPECTASSETGROUP: 0xeb,
        OP_INSPECTASSETGROUPSUM: 0xec,
        OP_INSPECTOUTASSETCOUNT: 0xed,
        OP_INSPECTOUTASSETAT: 0xee,
        OP_INSPECTOUTASSETLOOKUP: 0xef,
        OP_INSPECTINASSETCOUNT: 0xf0,
        OP_INSPECTINASSETAT: 0xf1,
        OP_INSPECTINASSETLOOKUP: 0xf2,
    },
    packets: {
        OP_INSPECTPACKET: 0xf4,
        OP_INSPECTINPUTPACKET: 0xf5,
        OP_TUNNEL: 0xf7,
        OP_INSPECTINTENTMESSAGE: 0xf8,
    },
} as const;

export type FamilyName = keyof typeof OPCODE_FAMILIES;

export const RESERVED = {
    OP_RESERVED: 0x50,
    OP_VER: 0x62,
    OP_VERIF: 0x65,
    OP_VERNOTIF: 0x66,
    OP_RESERVED1: 0x89,
    OP_RESERVED2: 0x8a,
};

export const INVALID = {
    OP_UNKNOWN188: 0xbc,
    OP_UNKNOWN189: 0xbd,
    OP_UNKNOWN190: 0xbe,
    OP_UNKNOWN191: 0xbf,
    OP_UNKNOWN192: 0xc0,
    OP_UNKNOWN193: 0xc1,
    OP_UNKNOWN194: 0xc2,
    OP_UNKNOWN208: 0xd0,
    OP_UNKNOWN221: 0xdd,
    OP_UNKNOWN222: 0xde,
    OP_UNKNOWN223: 0xdf,
    OP_UNKNOWN249: 0xf9,
    OP_SMALLINTEGER: 0xfa,
    OP_PUBKEYS: 0xfb,
    OP_UNKNOWN252: 0xfc,
    OP_PUBKEYHASH: 0xfd,
    OP_PUBKEY: 0xfe,
    OP_INVALIDOPCODE: 0xff,
};

function names(): string[] {
    const slots: string[] = [];
    const put = (value: number, name: string) => {
        if (slots[value]) throw new Error(`opcode slot ${value} assigned twice`);
        slots[value] = name;
    };
    put(0x00, "OP_0");
    for (let n = 1; n <= 75; n++) put(n, `OP_DATA_${n}`);
    put(0x4c, "OP_PUSHDATA1");
    put(0x4d, "OP_PUSHDATA2");
    put(0x4e, "OP_PUSHDATA4");
    put(0x4f, "OP_1NEGATE");
    for (let n = 1; n <= 16; n++) put(0x50 + n, `OP_${n}`);
    const tables: Readonly<Record<string, number>>[] = [
        RESERVED,
        INVALID,
        ...Object.values(OPCODE_FAMILIES),
    ];
    for (const table of tables) for (const [name, value] of Object.entries(table)) put(value, name);
    for (let value = 0; value < 256; value++) {
        if (!slots[value]) throw new Error(`opcode slot ${value} is empty`);
    }
    return slots;
}

export const opcodeNames: readonly string[] = names();

/** Includes Go's aliases. */
export const OpcodeByName: ReadonlyMap<string, number> = new Map([
    ...opcodeNames.map((name, value): [string, number] => [name, value]),
    ["OP_FALSE", 0x00],
    ["OP_TRUE", 0x51],
    ["OP_NOP2", 0xb1],
    ["OP_NOP3", 0xb2],
    ["OP_MERKLEBRANCHVERIFY", 0xb3],
]);
