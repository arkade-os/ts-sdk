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

show_help() {
    echo "Usage: $0 [options]"
    echo ""
    echo "Options:"
    echo "  --dry-run     Run without making any changes"
    echo "  --cleanup     Clean up release artifacts"
    echo "  --help        Show this help message"
    echo ""
    echo "Release types:"
    echo "  Standard releases: patch, minor, major"
    echo "  Pre-releases: prepatch, preminor, premajor, prerelease"
    echo "  Pre-release identifiers: alpha, beta, rc (release candidate)"
    echo ""
    echo "Examples:"
    echo "  Standard release:    $0"
    echo "  Alpha pre-release:   $0 --dry-run (then select prepatch/preminor/premajor with alpha)"
    echo "  Beta pre-release:    $0 (then select prerelease with beta)"
    echo "  Release candidate:   $0 (then select prerelease with rc)"
}

# Handle flags
DRY_RUN=false
while [[ $# -gt 0 ]]; do
    case $1 in
        --cleanup)
            cleanup
            ;;
        --dry-run)
            DRY_RUN=true
            echo "🏃 Dry run mode - no changes will be committed"
            shift
            ;;
        --help)
            show_help
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            show_help
            exit 1
            ;;
    esac
done

if [ "$DRY_RUN" = false ]; then
    # Ensure we're in a clean state
    if [[ -n $(git status --porcelain) ]]; then
        echo "Error: Working directory is not clean. Please commit or stash changes first."
        exit 1
    fi
fi

# Get the version bump type
echo "What kind of version bump?"
echo "Standard releases: patch, minor, major"
echo "Pre-releases: prepatch, preminor, premajor, prerelease"
read VERSION_BUMP

# Handle pre-release identifiers
PRERELEASE_ID=""
if [[ "$VERSION_BUMP" == pre* ]]; then
    echo "What pre-release identifier? (alpha|beta|rc)"
    read PRERELEASE_ID
    
    # Validate pre-release identifier
    if [[ "$PRERELEASE_ID" != "alpha" && "$PRERELEASE_ID" != "beta" && "$PRERELEASE_ID" != "rc" ]]; then
        echo "Error: Invalid pre-release identifier. Use alpha, beta, or rc."
        exit 1
    fi
fi

if [ "$DRY_RUN" = true ]; then
    # Simulate version bump without making changes
    CURRENT_VERSION=$(node -p "require('./package.json').version")
    echo "Current version: $CURRENT_VERSION"
    
    if [[ "$VERSION_BUMP" == pre* && -n "$PRERELEASE_ID" ]]; then
        # For pre-releases with identifier
        NEW_VERSION=$(npm version $VERSION_BUMP --preid=$PRERELEASE_ID --no-git-tag-version --dry-run 2>&1 | sed 's/v//')
        echo "Would create pre-release version: $NEW_VERSION ($PRERELEASE_ID)"
    else
        # For regular releases
        NEW_VERSION=$(npm version $VERSION_BUMP --no-git-tag-version --dry-run 2>&1 | sed 's/v//')
        echo "Would create new version: $NEW_VERSION"
    fi
    
    echo "Would create git tag: v$NEW_VERSION"
    
    # Show npm publish command that would be used
    if [[ "$NEW_VERSION" == *-* ]]; then
        # Pre-release version contains a hyphen
        if [[ "$NEW_VERSION" == *alpha* ]]; then
            echo "Would publish to npm with alpha tag: pnpm publish --tag alpha --dry-run"
        elif [[ "$NEW_VERSION" == *beta* ]]; then
            echo "Would publish to npm with beta tag: pnpm publish --tag beta --dry-run"
        elif [[ "$NEW_VERSION" == *rc* ]]; then
            echo "Would publish to npm with rc tag: pnpm publish --tag rc --dry-run"
        else
            echo "Would publish to npm with next tag: pnpm publish --tag next --dry-run"
        fi
    else
        echo "Would publish to npm with latest tag: pnpm publish --dry-run"
    fi
else
    # Real version bump and publish
    if [[ "$VERSION_BUMP" == pre* && -n "$PRERELEASE_ID" ]]; then
        # For pre-releases with identifier
        pnpm version $VERSION_BUMP --preid=$PRERELEASE_ID --no-git-tag-version
    else
        # For regular releases
        pnpm version $VERSION_BUMP --no-git-tag-version
    fi

    # Get the new version number directly from package.json
    NEW_VERSION=$(node -p "require('./package.json').version")

    # Create git tag manually
    git tag "v$NEW_VERSION"

    # Commit the package.json changes
    git add package.json
    
    # Use appropriate commit message
    if [[ "$NEW_VERSION" == *-* ]]; then
        git commit -m "chore: release $NEW_VERSION"
    else
        git commit -m "chore: release $NEW_VERSION"
    fi

    # Push the tag to trigger GitHub release
    git push origin "v$NEW_VERSION"

    # Publish to npm with appropriate tag
    echo "Publishing to npm..."
    if [[ "$NEW_VERSION" == *-* ]]; then
        # Pre-release version contains a hyphen
        if [[ "$NEW_VERSION" == *alpha* ]]; then
            echo "📦 Publishing alpha release..."
            pnpm publish --tag alpha
        elif [[ "$NEW_VERSION" == *beta* ]]; then
            echo "📦 Publishing beta release..."
            pnpm publish --tag beta
        elif [[ "$NEW_VERSION" == *rc* ]]; then
            echo "📦 Publishing release candidate..."
            pnpm publish --tag rc
        else
            echo "📦 Publishing pre-release..."
            pnpm publish --tag next
        fi
    else
        echo "📦 Publishing stable release..."
        pnpm publish
    fi
fi

# Show installation instructions
if [[ "$NEW_VERSION" == *-* ]]; then
    echo ""
    echo "📋 Installation instructions:"
    if [[ "$NEW_VERSION" == *alpha* ]]; then
        echo "   npm install your-package@alpha"
        echo "   npm install your-package@$NEW_VERSION"
    elif [[ "$NEW_VERSION" == *beta* ]]; then
        echo "   npm install your-package@beta"
        echo "   npm install your-package@$NEW_VERSION"
    elif [[ "$NEW_VERSION" == *rc* ]]; then
        echo "   npm install your-package@rc"
        echo "   npm install your-package@$NEW_VERSION"
    else
        echo "   npm install your-package@next"
        echo "   npm install your-package@$NEW_VERSION"
    fi
else
    echo ""
    echo "📋 Installation instructions:"
    echo "   npm install your-package@latest"
    echo "   npm install your-package@$NEW_VERSION"
fi

echo "✨ ${DRY_RUN:+[DRY RUN] }Version $NEW_VERSION processed" 