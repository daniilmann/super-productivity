// CommonJS can export a promise; dynamic imports keep this config under the
// same strict no-require-imports rule as every other new JavaScript file.
module.exports = (async () => {
  const { defineConfig } = await import('eslint/config');
  const { default: tseslint } = await import('typescript-eslint');
  const { default: upstream } = await import('./eslint.config.js');
  const files = ['**/*.{ts,tsx,js,mjs}'];

  return defineConfig(
    ...upstream,
    {
      files,
      // Preserve tseslint.config's file override; defineConfig intersects file globs.
      extends: tseslint.configs.strictTypeChecked.map((config) => ({ ...config, files })),
      languageOptions: {
        parserOptions: {
          tsconfigRootDir: __dirname,
          projectService: {
            allowDefaultProject: ['eslint.fork.config.js'],
            defaultProject: 'fork/tsconfig.json',
          },
        },
      },
    },
    {
      files,
      linterOptions: { noInlineConfig: true },
      rules: {
        complexity: ['error', { max: 30, variant: 'classic' }],
        'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      },
    },
  );
})();
