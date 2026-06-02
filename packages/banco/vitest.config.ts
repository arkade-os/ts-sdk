/// <reference types="vitest" />
import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../config/vitest.base";

export default mergeConfig(base, defineConfig({}));
