import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import reactCompiler from "babel-plugin-react-compiler";

// https://vite.dev/config/
export default defineConfig({
    plugins: [
        react({
            babel: {
                plugins: [reactCompiler],
            },
        }),
    ],
});
