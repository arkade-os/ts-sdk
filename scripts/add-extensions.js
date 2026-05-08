/**
 * ESM Import Path Fixer
 * 
 * This script adds .js extensions to relative imports in compiled output files.
 * It's necessary for Node.js ESM compatibility since Node.js requires explicit file extensions
 * in import statements when using ES modules.
 * 
 * The script:
 * 1. Finds files in the ESM and types output directories
 * 2. For each file, it processes all relative imports
 * 3. Adds .js extensions where needed, handling various edge cases
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { glob } from 'glob';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const outputDirs = [
  {
    dir: path.join(rootDir, 'dist', 'esm'),
    pattern: '**/*.js',
    lookupExtensions: ['.js'],
  },
  {
    dir: path.join(rootDir, 'dist', 'types'),
    pattern: '**/*.d.ts',
    lookupExtensions: ['.d.ts'],
  },
];

/**
 * Resolves an import path to include the correct extension
 * @param {string} importPath - The original import path
 * @param {string} currentDir - The directory of the file containing the import
 * @returns {string} - The resolved import path with proper extension
 */
function resolveImportPath(importPath, currentDir, lookupExtensions) {
  // If it already has an extension, return as is
  if (path.extname(importPath)) {
    return importPath;
  }

  for (const extension of lookupExtensions) {
    const absolutePath = path.resolve(currentDir, `${importPath}${extension}`);

    if (fs.existsSync(absolutePath)) {
      return `${importPath}.js`;
    }
  }

  for (const extension of lookupExtensions) {
    const indexPath = path.resolve(currentDir, `${importPath}/index${extension}`);
    if (fs.existsSync(indexPath)) {
      return `${importPath}/index.js`;
    }
  }

  // If neither exists, add .js as a fallback
  return `${importPath}.js`;
}

function addExtensionsToContent(content, currentDir, lookupExtensions) {
  const fixSpecifier = (match, prefix, importPath, suffix) => {
    const resolvedPath = resolveImportPath(importPath, currentDir, lookupExtensions);
    return `${prefix}${resolvedPath}${suffix}`;
  };

  return content
    .replace(/(from\s+['"])(\.[^'"]*)(['"])/g, fixSpecifier)
    .replace(/(import\(\s*['"])(\.[^'"]*)(['"]\s*\))/g, fixSpecifier);
}

/**
 * Main function to add extensions to all ESM imports
 */
async function addExtensions() {
  try {
    const existingOutputDirs = outputDirs.filter(({ dir }) => fs.existsSync(dir));
    let fixedImports = 0;

    for (const { dir, pattern, lookupExtensions } of existingOutputDirs) {
      const files = await glob(pattern, { cwd: dir });

      for (const file of files) {
        const filePath = path.join(dir, file);
        const fileDir = path.dirname(filePath);
        const content = fs.readFileSync(filePath, 'utf8');
        const updatedContent = addExtensionsToContent(content, fileDir, lookupExtensions);

        if (content !== updatedContent) {
          fixedImports++;
          fs.writeFileSync(filePath, updatedContent);
        }
      }
    }

    console.log(`✅ Added .js extensions to imports in ${fixedImports} files`);
  } catch (error) {
    console.error('Error adding extensions:', error);
    process.exit(1);
  }
}

addExtensions();
