import base from "./eslint.config.mjs";

/**
 * The same rules as always, type-checked against tsconfig.review.json — no
 * @types/node, the way the community review sees the code.
 *
 * Without this, a Node API used directly still passes locally (where the types
 * resolve) and comes back as a page of "unsafe call" warnings from the review.
 * Everything reaching into Node goes through src/utils/node-api.ts so both
 * runs stay clean.
 */
export default [
  ...base,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ["./tsconfig.review.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
];
