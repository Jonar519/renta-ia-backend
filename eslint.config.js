// @ts-check
const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
const prettier = require("eslint-config-prettier");
const globals = require("globals");

module.exports = tseslint.config(
  { ignores: ["dist/", "node_modules/", "coverage/", "uploads/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      // Parámetros/variables que empiezan con "_" se consideran intencionalmente sin usar.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "no-console": "off",
    },
  },
  {
    files: ["eslint.config.js"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  // Desactiva reglas de estilo que chocan con Prettier (debe ir al final).
  prettier
);
