export function getPath(root: unknown, path: string): unknown {
  if (!path) return root;
  return path.split(".").reduce<unknown>((value, key) => {
    if (Array.isArray(value) && /^\d+$/.test(key)) return value[Number(key)];
    if (value && typeof value === "object" && key in value) return (value as Record<string, unknown>)[key];
    return undefined;
  }, root);
}

export function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) throw new Error("Cannot set an empty workflow data path.");
  let cursor: Record<string, unknown> = root;
  for (const part of parts.slice(0, -1)) {
    const existing = cursor[part];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

export function renderValue(template: unknown, context: Record<string, unknown>): unknown {
  if (typeof template === "string") {
    const exact = template.match(/^{{\s*([\w.$-]+)\s*}}$/);
    if (exact?.[1]) return getPath(context, exact[1]);
    return template.replace(/{{\s*([\w.$-]+)\s*}}/g, (_, path: string) => {
      const value = getPath(context, path);
      return value === undefined || value === null ? "" : String(value);
    });
  }
  if (Array.isArray(template)) return template.map((item) => renderValue(item, context));
  if (template && typeof template === "object") {
    return Object.fromEntries(Object.entries(template as Record<string, unknown>).map(([key, value]) => [key, renderValue(value, context)]));
  }
  return template;
}

export function renderTemplate(template: string, context: Record<string, unknown>): string {
  return String(renderValue(template, context));
}

export function normalizeAnswer(value: string): string {
  return value.trim().toLocaleLowerCase("es").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
