/**
 * commitlint — conventional commits enforced by the .husky/commit-msg hook.
 *
 * Uses @commitlint/config-conventional defaults and adds one relaxation via a
 * local plugin rule: an optional task-id prefix (e.g. `[TASK-123]`) may precede
 * the conventional header, so the Commonly workflow
 * `git commit -m "[TASK-123] feat: ..."` stays valid while the type/scope/
 * subject rules still apply.
 */
export default {
  extends: ["@commitlint/config-conventional"],
  plugins: [
    {
      rules: {
        "header-pattern": (parsed) => {
          const { header } = parsed;
          if (!header) return [true];
          const ok = /^(?:\[[A-Z][A-Z0-9-]*\]\s+)?(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test|merge)(?:\([\w-]+\))?!?:\s+.+$/.test(header);
          return [
            ok,
            "header must be conventional: [TASK-XXX] type(scope): subject",
          ];
        },
      },
    },
  ],
  rules: {
    // The default parser does not understand the optional [TASK-XXX] prefix, so
    // type-empty/subject-empty would misfire on prefixed headers; the custom
    // header-pattern rule below enforces the same structure anyway.
    "type-empty": [0],
    "subject-empty": [0],
    "header-pattern": [2, "always"],
  },
};
