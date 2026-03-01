import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**"]
  },
  {files: ["**/*.{js,mjs,cjs,ts}"]},
  {languageOptions: { globals: globals.node }},
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "warn"
    }
  },
  {
    files: ["src/middleware/express.ts"],
    rules: {
      "@typescript-eslint/no-namespace": "off"
    }
  },
  {
    files: ["src/tracer/exporters.ts", "src/transports/index.ts", "src/logger/logger.ts"],
    rules: {
      "no-console": "off"
    }
  }
];
