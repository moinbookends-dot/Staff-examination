import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  // ── Confine the RLS-bypassing admin client ────────────────────────────────
  //
  // src/lib/supabase/admin.ts creates a Supabase client with the secret key,
  // which ignores every Row-Level Security policy. Importing it from a page,
  // a component, or an arbitrary lib module is how a solo-dev project quietly
  // grows an authorisation hole. Restrict it to the two layers that legitimately
  // need it — and even there, every call site must gate on requirePermission().
  //
  // `import 'server-only'` inside admin.ts is the second line of defence; this
  // rule is the first, because it fails in the editor rather than at build time.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/app/api/**",
      "src/server/actions/**",
      "src/lib/supabase/admin.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/supabase/admin", "@/lib/supabase/admin"],
              message:
                "The admin client bypasses RLS. Import it only from src/app/api/** or src/server/actions/**, and gate every call on requirePermission(). If RLS is blocking you, fix the policy instead.",
            },
          ],
        },
      ],
    },
  },

  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
