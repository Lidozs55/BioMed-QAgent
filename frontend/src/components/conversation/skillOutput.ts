export interface FindSkillSummary {
  total: number;
  names: string[];
}

/** Parse find_skill's JSON output; null when missing/unparseable. */
export function parseFindSkillOutput(
  output: string | null,
): FindSkillSummary | null {
  if (!output) return null;
  try {
    const parsed = JSON.parse(output) as {
      skills?: Array<{ name?: string; display_name?: string }>;
    };
    if (!Array.isArray(parsed.skills)) return null;
    const names = parsed.skills
      .map((skill) => skill.display_name ?? skill.name ?? "")
      .filter((name) => name.length > 0);
    return { total: names.length, names };
  } catch {
    return null;
  }
}
