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
    // One command ships with a key on it: "Open terminal" on Mod+J.
    //
    // The rule is right in general — a default hotkey can take a key away from
    // something the user already has on it, and the plugin has no way of
    // knowing. This one was checked against Obsidian's own bindings before it
    // was chosen: Mod+T is "New tab", Mod+S saves, Mod+F searches the file,
    // and Mod+J is free. It is also where VS Code keeps the panel the terminal
    // lives in. Settings -> Hotkeys clears it in one click and is where a
    // conflict with another plugin would be shown.
    //
    // Scoped to the one file rather than switched off everywhere, the same way
    // the Node import rule is, so a second default hotkey somewhere else still
    // has to be argued for.
    files: ["src/main.ts"],
    rules: {
      "obsidianmd/commands/no-default-hotkeys": "off",
    },
  },
  {
    ignores: ["main.js", "dist/", "node_modules/", "*.config.*", "scripts/", "tests/"],
  },
);
