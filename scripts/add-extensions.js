/**
 * ESM Import Path Fixer
 * 
 * This script adds .js extensions to all ESM imports in the compiled JavaScript files.
 * It's necessary for Node.js ESM compatibility since Node.js requires explicit file extensions
 * in import statements when using ES modules.
 * 
 * The script:
 * 1. Finds all JS files in the ESM output directory
 * 2. For each file, it processes all relative imports
 * 3. Adds .js extensions where needed, handling various edge cases
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { glob } from 'glob';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const esmDir = path.join(rootDir, 'dist', 'esm');

/**
 * Resolves an import path to include the correct extension
 * @param {string} importPath - The original import path
 * @param {string} currentDir - The directory of the file containing the import
 * @returns {string} - The resolved import path with proper extension
 */
function resolveImportPath(importPath, currentDir) {
  // If it already has .js extension, return as is
  if (importPath.endsWith('.js')) {
    return importPath;
  }
  
  // Check if the file exists with .js extension
  const withJsExt = `${importPath}.js`;
  const absolutePath = path.resolve(currentDir, withJsExt);
  
  if (fs.existsSync(absolutePath)) {
    return withJsExt;
  }
  
  // Check if it's a directory with an index.js file
  const indexPath = path.resolve(currentDir, `${importPath}/index.js`);
  if (fs.existsSync(indexPath)) {
    return `${importPath}/index.js`;
  }
  
  // If neither exists, add .js as a fallback
  return `${importPath}.js`;
}

/**
 * Main function to add extensions to all ESM imports
 */
async function addExtensions() {
  try {
    // Find all JS files in the ESM directory
    const files = await glob('**/*.js', { cwd: esmDir });
    let fixedImports = 0;
    
    for (const file of files) {
      const filePath = path.join(esmDir, file);
      const fileDir = path.dirname(filePath);
      let content = fs.readFileSync(filePath, 'utf8');
      
      // Replace relative imports without extensions
      const updatedContent = content.replace(
        /from\s+['"](\.[^'"]*)['"]/g,
        (match, importPath) => {
          // Skip if already has an extension
          if (importPath.endsWith('.js')) {
            return match;
          }
          
          const resolvedPath = resolveImportPath(importPath, fileDir);
          fixedImports++;
          return `from '${resolvedPath}'`;
        }
      );
      
      if (content !== updatedContent) {
        fs.writeFileSync(filePath, updatedContent);
      }
    }
    
    console.log(`✅ Added .js extensions to ${fixedImports} ESM imports`);
  } catch (error) {
    console.error('Error adding extensions:', error);
    process.exit(1);
  }
}

addExtensions();
