/**
 * Package.json Generator for ESM/CJS Compatibility
 * 
 * This script generates package.json files in the dist/esm and dist/cjs directories
 * to ensure proper module type identification by Node.js and other tools.
 * 
 * This is necessary to avoid the "dual package hazard" where the same package
 * is loaded twice in different formats, which can cause unexpected behavior.
 * 
 * See: https://nodejs.org/api/packages.html#dual-package-hazard
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

// Define package.json contents for each module format
const esmPackageJson = {
  "type": "module"
};

const cjsPackageJson = {
  "type": "commonjs"
};

/**
 * Ensures a directory exists, creating it if necessary
 * @param {string} dirPath - Directory path to ensure
 */
function ensureDirectoryExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Writes a package.json file to the specified directory
 * @param {string} dirPath - Directory to write the package.json to
 * @param {object} content - Content to write to the package.json
 */
function writePackageJson(dirPath, content) {
  ensureDirectoryExists(dirPath);
  
  fs.writeFileSync(
    path.join(dirPath, 'package.json'),
    JSON.stringify(content, null, 2)
  );
}

// Ensure directories exist and write package.json files
const esmDir = path.join(rootDir, 'dist', 'esm');
const cjsDir = path.join(rootDir, 'dist', 'cjs');

writePackageJson(esmDir, esmPackageJson);
writePackageJson(cjsDir, cjsPackageJson);

console.log('✅ Generated package.json files for ESM and CJS modules');
