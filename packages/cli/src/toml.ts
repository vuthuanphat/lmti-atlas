
export function parseTomlString(value?: string): string {
  return value?.trim().replace(/^"|"$/gu, "") ?? "";
}

export function parseTomlStringArray(value?: string): string[] {
  if (!value) {
    return [];
  }
  const inner = value.trim().replace(/^\[/u, "").replace(/\]$/u, "");
  return inner.split(",").map((item) => parseTomlString(item.trim())).filter(Boolean);
}

export function parseTomlBoolean(value?: string): boolean {
  return value?.trim().toLowerCase() === "true";
}
