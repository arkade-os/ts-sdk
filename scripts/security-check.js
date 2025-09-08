#!/usr/bin/env node

/**
 * Security Check Script
 * 
 * This script performs a security audit of the project dependencies
 * and provides information about any vulnerabilities found.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';

console.log('🔒 Running security audit...\n');

try {
  // Check if pnpm is available
  try {
    execSync('pnpm --version', { stdio: 'ignore' });
  } catch (error) {
    console.error('❌ pnpm is required but not found. Please install pnpm first.');
    process.exit(1);
  }

  // Run the audit
  const result = execSync('pnpm audit --json', { 
    encoding: 'utf8',
    cwd: process.cwd()
  });

  const auditData = JSON.parse(result);
  const { vulnerabilities } = auditData.metadata;
  
  const totalVulns = Object.values(vulnerabilities).reduce((sum, count) => sum + count, 0);

  if (totalVulns === 0) {
    console.log('✅ No vulnerabilities found!');
    console.log(`📊 Scanned ${auditData.metadata.totalDependencies} dependencies`);
  } else {
    console.log('⚠️  Vulnerabilities found:');
    Object.entries(vulnerabilities).forEach(([severity, count]) => {
      if (count > 0) {
        console.log(`   ${severity}: ${count}`);
      }
    });
    
    // Show detailed information
    console.log('\n🔍 Run `pnpm audit` for detailed information about vulnerabilities.');
    process.exit(1);
  }

} catch (error) {
  if (error.status === 1) {
    // Audit found vulnerabilities, run the readable version
    console.log('⚠️  Vulnerabilities detected. Running detailed audit...\n');
    try {
      execSync('pnpm audit', { stdio: 'inherit' });
    } catch (auditError) {
      // Expected when vulnerabilities are found
    }
    process.exit(1);
  } else {
    console.error('❌ Error running security audit:', error.message);
    process.exit(1);
  }
}

console.log('\n🛡️  Security audit completed successfully!');