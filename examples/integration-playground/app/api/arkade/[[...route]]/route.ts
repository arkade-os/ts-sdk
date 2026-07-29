// Mount the checkout package's route handlers exactly as a consuming app would.
// This is the only way the ./server/route subpath export gets exercised.
//
// The mount path is NOT arbitrary. Checkout.tsx and useCheckout.tsx hardcode
// /api/arkade/{create,status,claim}, and webhook.ts self-calls /api/arkade/claim,
// so the handlers must be mounted here or the client flow 404s at runtime. See
// the package README's mount-path note.
export { GET, POST } from "@arkade-os/checkout/server/route";
