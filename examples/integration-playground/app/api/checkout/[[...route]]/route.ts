// Mount the checkout package's route handlers exactly as a consuming app would.
// This is the only way the ./server/route subpath export gets exercised, and it
// is what makes the root-vs-subpath split meaningful.
export { GET, POST } from "@arkade-os/checkout/server/route";
