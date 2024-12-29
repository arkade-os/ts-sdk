#!/bin/bash

cleanup() {
    echo "🧹 Cleaning up release artifacts..."
    # Get current version from package.json
    CURRENT_VERSION=$(node -p "require('./package.json').version")
    
    # Reset any changes to package.json
    git checkout package.json
    
    # Remove local tag if it exists
    if git tag | grep -q "v$CURRENT_VERSION"; then
        git tag -d "v$CURRENT_VERSION"
        echo "✓ Removed local git tag v$CURRENT_VERSION"
    fi
    
    echo "✨ Cleanup complete"
    exit 0
}

# Handle cleanup flag
if [ "$1" == "--cleanup" ]; then
    cleanup
fi

# Check for --dry-run flag
DRY_RUN=false
if [ "$1" == "--dry-run" ]; then
    DRY_RUN=true
    echo "🏃 Dry run mode - no changes will be committed"
fi

if [ "$DRY_RUN" = false ]; then
    # Ensure we're in a clean state
    if [[ -n $(git status --porcelain) ]]; then
        echo "Error: Working directory is not clean. Please commit or stash changes first."
        exit 1
    fi
fi

# Get the version bump type
echo "What kind of version bump? (patch|minor|major)"
read VERSION_BUMP

if [ "$DRY_RUN" = true ]; then
    # Simulate version bump without making changes
    CURRENT_VERSION=$(node -p "require('./package.json').version")
    echo "Would bump version from $CURRENT_VERSION"
    NEW_VERSION=$(npm version $VERSION_BUMP --no-git-tag-version --dry-run 2>&1 | sed 's/v//')
    echo "Would create new version: $NEW_VERSION"
    echo "Would create git tag: v$NEW_VERSION"
    echo "Would publish to npm (dry run)..."
    pnpm publish --dry-run
else
    # Real version bump and publish
    pnpm version $VERSION_BUMP

    # Get the new version number
    NEW_VERSION=$(node -p "require('./package.json').version")

    # Push the tag to trigger GitHub release
    git push origin "v$NEW_VERSION"

    # Publish to npm
    echo "Publishing to npm..."
    pnpm publish
fi

echo "✨ ${DRY_RUN:+[DRY RUN] }Version $NEW_VERSION processed" 