export const typedFiles = ["**/*.{ts,tsx,mts,cts}"];
// These names are excluded only directly under a package or repository root.
// Nested output names remain in lint and source inventory. ESLint also ignores
// nested node_modules; the ratchet rejects tracked paths containing that segment.
export const generatedDirectories = [
  "node_modules",
  "dist",
  "dist-loadtest",
  "build",
  "coverage",
];

// Preserve the existing console policy across conventional test paths.
export const testConsoleFiles = [
  "**/*.{test,spec}.{ts,tsx,mts,cts}",
  "**/{test,tests,__tests__}/**/*.{ts,tsx,mts,cts}",
];

export const doubleAssertionGuard = {
  selector: "TSAsExpression > TSAsExpression",
  message:
    "Double type assertions are banned. Narrow unknown input with a guard.",
};

export const arrayGuard = {
  selector:
    "CallExpression[callee.object.name='Array'][callee.property.name='isArray']",
  message: "Use the isArray guard to preserve unknown elements.",
};

export const hardenedRules = {
  "no-inner-declarations": [
    "error",
    "functions",
    { blockScopedFunctions: "disallow" },
  ],
  "no-constant-condition": ["error", { checkLoops: true }],
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-non-null-assertion": "error",
  "@typescript-eslint/consistent-type-assertions": [
    "error",
    { assertionStyle: "never" },
  ],
  "@typescript-eslint/consistent-type-imports": [
    "error",
    {
      prefer: "type-imports",
      fixStyle: "separate-type-imports",
      disallowTypeAnnotations: false,
    },
  ],
  "@typescript-eslint/ban-ts-comment": [
    "error",
    {
      "ts-check": true,
      "ts-ignore": true,
      "ts-expect-error": true,
      "ts-nocheck": true,
    },
  ],
  "no-warning-comments": [
    "error",
    { terms: ["@ts-nocheck"], location: "start", decoration: ["/"] },
  ],
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/restrict-template-expressions": [
    "error",
    { allowNumber: true },
  ],
  "no-restricted-syntax": ["error", doubleAssertionGuard],
  "no-console": "error",
};

// Disabling inline configuration also disables ESLint's unused-directive
// reporting. Inspect actual comments so even ineffective directives fail.
export const suppressionGuard = {
  files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
  linterOptions: {
    noInlineConfig: true,
    reportUnusedDisableDirectives: "error",
  },
  plugins: {
    "lint-policy": {
      rules: {
        "no-inline-config": {
          meta: {
            type: "problem",
            schema: [],
            messages: {
              forbidden:
                "Inline ESLint configuration is forbidden. Resolve the finding and shrink the ratchet.",
            },
          },
          create(context) {
            return {
              Program() {
                for (const comment of context.sourceCode.getAllComments()) {
                  if (/^\s*eslint(?:\s|$|-)/u.test(comment.value)) {
                    context.report({
                      loc: comment.loc,
                      messageId: "forbidden",
                    });
                  }
                }
              },
            };
          },
        },
      },
    },
  },
  rules: { "lint-policy/no-inline-config": "error" },
};
