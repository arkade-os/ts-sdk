export function assertReleaseDependencies(selectedKeys, solverDiscoveryDependency) {
    if (
        selectedKeys.includes("swap") &&
        typeof solverDiscoveryDependency === "string" &&
        solverDiscoveryDependency.startsWith("file:")
    ) {
        throw new Error(
            `Cannot release @arkade-os/swap with file: dependency ${solverDiscoveryDependency}. ` +
                "Replace vendored @arkade-os/solver-discovery with a published release before releasing swap or sdk.",
        );
    }
}
