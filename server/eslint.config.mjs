import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import ts from "typescript";
import createNodeTestPlugin, {
  nodeTestFiles,
} from "../scripts/eslint-node-test.mjs";
import {
  arrayGuard,
  doubleAssertionGuard,
  generatedDirectories,
  hardenedRules,
  suppressionGuard,
  typedFiles,
} from "../scripts/eslint-policy.mjs";
import { editorOverrides, readRatchet } from "../scripts/lint-ratchet-lib.mjs";

export const strictConfig = tseslint.config(
  { ignores: generatedDirectories.map((directory) => `**/${directory}/**`) },
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
    plugins: { "node-test": createNodeTestPlugin(ts) },
    rules: {
      ...hardenedRules,
      "node-test/direct-registrations": "error",
      "node-test/no-floating-subtests": "error",
      "no-restricted-syntax": ["error", doubleAssertionGuard, arrayGuard],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: nodeTestFiles,
    rules: {
      // Companion rules confine this allowance to direct registration calls
      // and require awaited or returned subtests.
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            {
              from: "package",
              package: "node:test",
              name: ["test", "describe", "it", "suite", "skip", "only", "todo"],
            },
          ],
        },
      ],
    },
  },
  {
    files: typedFiles,
    ignores: nodeTestFiles,
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
