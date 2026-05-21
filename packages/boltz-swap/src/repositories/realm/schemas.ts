/**
 * Realm object schemas for the Boltz swap repository.
 *
 * All schema names are prefixed with "Boltz" to avoid collisions with
 * other Realm schemas in the consuming application.
 *
 * Since `realm` is a peer dependency (not installed in this package),
 * schemas are defined as plain JS objects conforming to Realm's
 * ObjectSchema shape.
 */

export const BoltzSwapSchema = {
    name: "BoltzSwap",
    primaryKey: "id",
    properties: {
        id: "string",
        type: "string",
        status: "string",
        createdAt: "int",
        data: "string",
    },
};

export const BoltzRealmSchemas = [BoltzSwapSchema];
