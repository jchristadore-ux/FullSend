import next from 'eslint-config-next';

/*
 * Next 16 removed `next lint`, and `next build` no longer lints, so linting is
 * now the ESLint CLI against this flat config — the migration the upgrade
 * guide describes. Without it `npm run lint` failed with "Invalid project
 * directory", which reads like a broken checkout rather than a removed command.
 *
 * `eslint-config-next` ships flat configs directly at v16, so there is no
 * FlatCompat wrapper here.
 */
export default [
  {
    ignores: ['.next/**', 'node_modules/**', 'public/**', 'next-env.d.ts'],
  },
  ...next,
  {
    rules: {
      /*
       * The store is deliberately required lazily so the memory driver never
       * pulls in the Supabase client — the file carries the explanation, and an
       * import would defeat it.
       */
      '@typescript-eslint/no-require-imports': 'off',

      /*
       * Two React Compiler heuristics, reported but not blocking.
       *
       * `purity` flags `Date.now()` in async server components, which run once
       * on the server and never re-render, and `set-state-in-effect` flags the
       * hydration-safe pattern of reading `localStorage` or starting a poll in
       * an effect — the thing React's own guidance recommends for values that
       * do not exist during SSR. Both are worth seeing; neither describes a
       * defect here, and silencing them file by file would hide the cases that
       * genuinely are one.
       */
      'react-hooks/purity': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
];
