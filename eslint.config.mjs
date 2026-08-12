import js from "@eslint/js";

// Correctness only. Formatting is Prettier's, so nothing here has an opinion about whitespace.
export default [
  { ignores: ["node_modules/", ".data/", ".scratch/"] },
  js.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { console: "readonly", process: "readonly", URL: "readonly" },
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "prefer-const": "error",
    },
  },
];
