import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import obsidianmd from "eslint-plugin-obsidianmd";

/**
 * The Obsidian community review runs `eslint-plugin-obsidianmd` alongside
 * typescript-eslint's type-checked rules. Both run here, and CI fails on any
 * warning, so a submission cannot fail on something this could have caught.
 */
export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...obsidianmd.configs.recommended,
  eslintConfigPrettier,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/explicit-function-return-type": [
        "error",
        {
          allowExpressions: true,
        },
      ],
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    // Git runs through child_process, which is the whole point of the plugin.
    // The manifest declares it desktop-only for exactly this reason.
    files: ["src/git/git-service.ts", "src/main.ts"],
    rules: {
      "obsidianmd/no-nodejs-modules": "off",
    },
  },
  {
    ignores: ["main.js", "dist/", "node_modules/", "*.config.*", "scripts/", "tests/"],
  },
);
