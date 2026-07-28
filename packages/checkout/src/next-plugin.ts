export default function withArkadeCheckout(nextConfig: any = {}) {
    return {
        ...nextConfig,
        webpack: (config: any, options: any) => {
            // Add any webpack customizations here

            if (typeof nextConfig.webpack === "function") {
                return nextConfig.webpack(config, options);
            }

            return config;
        },
    };
}
