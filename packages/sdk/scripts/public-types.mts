import {
    type ArkadeHTLC,
    type arkade,
    type OnchainHTLC,
    type ServiceWorkerWallet,
    type WalletUpdate,
} from "@arkade-os/sdk";

export interface ProgramTypes {
    argType: arkade.ArkadeArgType;
    argValue: arkade.ArkadeArgValue;
    contractParams: arkade.ArkadeContractParams;
    function: arkade.ArkadeFunction;
    paramValue: arkade.ArkadeParamValue;
    segment: arkade.ArkadeSegment;
    service: arkade.ArkadeService;
    asmToken: arkade.AsmToken;
    compiledFunction: arkade.CompiledProgramFunction;
    inputDef: arkade.InputDef;
    inputRef: arkade.InputRef;
    program: arkade.Program;
    keys: arkade.ProgramKeys;
    resolvedService: arkade.ResolvedArkadeService;
    script: arkade.ScriptType;
    signerRef: arkade.SignerRef;
    sourceRange: arkade.SourceRange;
    tapscript: arkade.TapscriptSegment;
    tweakedSigner: arkade.TweakedSigner;
    witnessRef: arkade.WitnessRef;
}

export type CallableFunctions = arkade.CallableFunctions;
export type ContractFunctions = arkade.ContractFunctions<arkade.Program>;
export type ContractUnlockers = arkade.ContractUnlockers<arkade.Program>;
export type ArkadeHTLCOptions = ArkadeHTLC.Options;
export type OnchainHTLCOptions = OnchainHTLC.Options;

declare const wallet: ServiceWorkerWallet;
const unsubscribe: () => void = wallet.onWalletUpdate((update: WalletUpdate) => {
    if (update.type === "CONTRACT_EVENT") update.payload.event.type satisfies string;
    else if (update.type === "UTXO_UPDATE") update.payload.coins.length satisfies number;
    else update.payload.newVtxos.length satisfies number;
});
void unsubscribe;
