const SENSITIVE_KEY_PATTERN =
  /^(?:private-token|authorization|cookie|set-cookie|token|password)$/iu;
const TOKEN_VALUE_PATTERN =
  /\b(?:glpat|glcbt|gldt|glrt|glsoat|glagent)-[A-Za-z0-9_-]+\b/gu;

export function redactText(value: string): string {
  return value
    .replace(TOKEN_VALUE_PATTERN, "[REDACTED]")
    .replace(
      /((?:PRIVATE-TOKEN|Authorization|Cookie|Set-Cookie)\s*[:=]\s*)[^\s,;]+/giu,
      "$1[REDACTED]",
    )
    .replace(/(https?:\/\/)[^/@\s]+@/giu, "$1[REDACTED]@");
}

export function redactUnknown(value: unknown): string {
  if (value instanceof Error) {
    return redactText(`${value.name}: ${value.message}`);
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  try {
    return redactText(
      JSON.stringify(value, (key, item: unknown) =>
        SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : item,
      ),
    );
  } catch {
    return "[Unserializable error]";
  }
}
