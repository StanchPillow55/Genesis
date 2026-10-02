/**
 * Stale draft from an earlier signup form.
 * Nothing in the checker imports this file.
 */
export function stripSpaces(value: string): string {
  return value.replace(/\s+/g, "");
}
