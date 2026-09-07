import type { ReactNode } from "react";

export const metadata = {
    title: "Arkade integration playground",
    description: "Minimal unified example for the Arkade web packages",
};

export default function RootLayout({ children }: { children: ReactNode }) {
    return (
        <html lang="en">
            <body
                style={{
                    fontFamily: "system-ui, sans-serif",
                    lineHeight: 1.5,
                    margin: 0,
                    padding: 24,
                }}
            >
                {children}
            </body>
        </html>
    );
}
