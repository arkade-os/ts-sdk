# Security Vulnerability Fixes

## Summary

This commit addresses all identified security vulnerabilities in the project dependencies.

## Vulnerabilities Fixed

### 1. esbuild CORS Vulnerability (Moderate - CVSS 5.3)
- **Issue**: esbuild ≤0.24.2 allows any website to send requests to development server
- **CVE**: GHSA-67mh-4wv8-2f99  
- **Impact**: Potential source code disclosure during development
- **Fix**: Updated to esbuild ≥0.25.0 via pnpm overrides

### 2. brace-expansion ReDoS Vulnerability (Low - CVSS 3.1)
- **Issue**: Regular Expression Denial of Service in brace-expansion ≤2.0.1
- **CVE**: CVE-2025-5889 / GHSA-v6h2-p8h4-qcjw
- **Impact**: Potential denial of service via inefficient regex
- **Fix**: Updated to brace-expansion ≥2.0.2 via pnpm overrides

## Changes Made

1. **Updated Dev Dependencies**:
   - vitest: 2.1.9 → 3.2.4
   - @vitest/coverage-v8: 2.1.9 → 3.2.4
   - esbuild: 0.25.0 → 0.25.9
   - glob: 11.0.1 → 11.0.3
   - typedoc: 0.27.9 → 0.28.12
   - @types/node: 22.10.2 → 24.3.1

2. **Added pnpm Overrides**:
   - Force esbuild ≥0.25.0 to address CORS vulnerability
   - Force brace-expansion ≥2.0.2 to address ReDoS vulnerability

3. **Added Security Tooling**:
   - New `security-check` script for easy vulnerability scanning
   - Automated security check script at `scripts/security-check.js`

## Verification

- ✅ All vulnerabilities resolved (0 found after fixes)
- ✅ All existing tests pass (46/46)
- ✅ Build process works correctly
- ✅ No breaking changes introduced

## Usage

Run security checks anytime with:
```bash
pnpm security-check  # User-friendly output
pnpm audit          # Detailed audit output
```