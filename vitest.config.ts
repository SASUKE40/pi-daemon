import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "node",
    environmentOptions: { jsdom: { url: "http://localhost:8504/" } },
    clearMocks: true,
  },
});
