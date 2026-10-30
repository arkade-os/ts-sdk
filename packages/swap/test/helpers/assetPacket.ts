import { base64 } from "@scure/base";
import { Extension, Transaction } from "@arkade-os/sdk";

/** Every asset group in a submitted ark tx's packet, as `[vin|vout, amount]` pairs. */
export const assetFlows = (psbt: string) => {
    const packet = Extension.fromTx(Transaction.fromPSBT(base64.decode(psbt))).getAssetPacket();
    if (!packet) throw new Error("the extension output carries no asset packet");
    return packet.groups.map((group) => ({
        assetId: group.assetId!.toString(),
        inputs: group.inputs.map((input) => [input.vin, input.amount]),
        outputs: group.outputs.map((output) => [output.vout, output.amount]),
    }));
};
