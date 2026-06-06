/** Quote a CSV field per RFC 4180 when it contains a comma, quote, or newline. */
function escapeField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * Serialize rows to RFC-4180 CSV text. `columns` defines the header order; each row
 * is looked up by column key (missing keys render as empty cells).
 */
export function toCsv(columns: readonly string[], rows: ReadonlyArray<Record<string, string>>): string {
  const header = columns.map(escapeField).join(",")
  const lines = rows.map((row) => columns.map((col) => escapeField(row[col] ?? "")).join(","))
  return `${[header, ...lines].join("\n")}\n`
}
