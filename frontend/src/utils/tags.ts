export function parseScenarioTags(tag?: string | null): string[] {
  if (!tag) return []
  try {
    const parsed = JSON.parse(tag)
    if (Array.isArray(parsed)) return parsed.map(String)
  } catch {
    return [tag]
  }
  return []
}

export function formatScenarioTags(tags: string[]): string {
  return JSON.stringify(tags)
}
