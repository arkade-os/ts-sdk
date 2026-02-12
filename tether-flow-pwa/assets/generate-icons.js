/**
 * Icon generation script for Tether Flow PWA.
 *
 * Run with Node.js to generate PNG icons from SVG.
 * For now, the app uses vector icons from @expo/vector-icons.
 *
 * To generate production icons, use a tool like:
 *   npx pwa-asset-generator ./assets/logo.svg ./public
 */

const SVG_ICON = `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" style="stop-color:#50AF95"/>
      <stop offset="100%" style="stop-color:#3D8F78"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="96" fill="url(#bg)"/>
  <text x="256" y="320" text-anchor="middle"
    font-family="Arial, sans-serif" font-weight="800" font-size="280"
    fill="white">&#x20AE;</text>
</svg>
`;

console.log("SVG Icon template:");
console.log(SVG_ICON);
console.log("\nSave this as logo.svg and use pwa-asset-generator to create PNGs.");
