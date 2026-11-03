import { defineConfig } from "vitest/config";
export default defineConfig({ test: { fsModuleCache: false, include: ["test/**/*.test.ts"] } });
