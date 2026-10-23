import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import {
  generatedDirectories,
  hardenedRules,
  suppressionGuard,
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
      parserOptions: { project: "./tsconfig.eslint.json", tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      ...hardenedRules,
      "@typescript-eslint/no-confusing-void-expression": [
        "error",
        { ignoreArrowShorthand: true, ignoreVoidOperator: true },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);

// Editor exceptions are counted under the full policy by both lint commands.
const ratchet = readRatchet(new URL("./eslint-ratchet.json", import.meta.url));
export default [...strictConfig, ...editorOverrides(ratchet)];
