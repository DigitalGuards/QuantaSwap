import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import {
  arrayGuard,
  doubleAssertionGuard,
  generatedDirectories,
  hardenedRules,
  suppressionGuard,
  testConsoleFiles,
  typedFiles,
} from "../scripts/eslint-policy.mjs";
import { editorOverrides, readRatchet } from "../scripts/lint-ratchet-lib.mjs";

export const strictConfig = tseslint.config(
  { ignores: generatedDirectories.map((directory) => `${directory}/**`) },
  suppressionGuard,
  {
    files: typedFiles,
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
      prettier,
    ],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...hardenedRules,
      "no-restricted-syntax": ["error", doubleAssertionGuard, arrayGuard],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: typedFiles,
    ignores: testConsoleFiles,
    // Services and scripts write to container stdout/stderr through console.
    rules: { "no-console": ["error", { allow: ["info", "warn", "error"] }] },
  },
  {
    // Preserve the existing native array checks in guards and fixtures.
    // The double-assertion ban and all type-aware rules apply here as well.
    files: ["src/guards.ts", "src/**/*.test.ts"],
    rules: { "no-restricted-syntax": ["error", doubleAssertionGuard] },
  },
);

// Editor exceptions are counted under the full policy by both lint commands.
const ratchet = readRatchet(new URL("./eslint-ratchet.json", import.meta.url));
export default [...strictConfig, ...editorOverrides(ratchet)];
