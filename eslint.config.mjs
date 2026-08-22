import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { ignores: ["main.js", "node_modules"] },
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: { globals: { window: "readonly", process: "readonly", FileReader: "readonly" } },
    rules: { "@typescript-eslint/no-explicit-any": "off" }
  }
);
