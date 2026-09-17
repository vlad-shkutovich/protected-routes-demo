import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

// ultracite's oxfmt preset with two overrides: wrap at 100 and trailing commas everywhere.
export default defineConfig({
  ...ultracite,
  ignorePatterns: [...(ultracite.ignorePatterns ?? []), "**/.claude/**"],
  printWidth: 100,
  trailingComma: "all",
});
