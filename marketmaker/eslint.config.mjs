import { readFileSync } from "node:fs";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export const strictConfig = tseslint.config(
  { ignores: ["node_modules/**", "dist/**", "dist-loadtest/**"] },
  {
    files: ["src/**/*.{ts,tsx,mts,cts}"],
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.object.name='Array'][callee.property.name='isArray']",
          message: "Use the isArray guard to preserve unknown elements.",
        },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-ignore": true,
          "ts-expect-error": true,
          "ts-nocheck": true,
          "ts-check": true,
        },
      ],
    },
  },
  {
    files: [
      "src/**/*.test.ts",
      "src/legacy-v1-test-helper.ts",
      "src/protocol-v2-test-helper.ts",
      "src/taker-test-harness.ts",
      "src/taker-survival-child.ts",
    ],
    rules: {
      "no-restricted-syntax": "off",
      // Node's test runner owns the promises returned by test registration.
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/consistent-type-assertions": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  { files: ["src/guards.ts"], rules: { "no-restricted-syntax": "off" } },
  prettier,
);

// Generated exact file/rule debt. npm run lint enforces each diagnostic ceiling.
export const ratchet = JSON.parse(
  readFileSync(new URL("./eslint-ratchet.json", import.meta.url), "utf8"),
);
export default [
  ...strictConfig,
  ...Object.entries(ratchet).map(([file, rules]) => ({
    files: [file],
    rules: Object.fromEntries(Object.keys(rules).map((rule) => [rule, "off"])),
  })),
];
