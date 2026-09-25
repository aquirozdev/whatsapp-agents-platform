export function log(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  fields: Record<string, unknown> = {},
): void {
  const record = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...fields,
  };
  console.log(JSON.stringify(record));
}
