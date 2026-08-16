// Destination names are shared by the course walk and media appearances. Keeping this pure lets
// both workflows agree on a numbered, filesystem-safe name without importing either workflow.
// eslint-disable-next-line no-control-regex -- control characters are what this strips
const RESERVED_CHARACTERS = /[\\/:*?"<>|\x00-\x1F]/g;

export function safeSegment(value) {
  return (
    String(value ?? "")
      .normalize("NFKC")
      .replace(RESERVED_CHARACTERS, "_")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+/, "") || "untitled"
  );
}

export function orderedName(position, name) {
  return `${String((position ?? 0) + 1).padStart(2, "0")} ${safeSegment(name)}`;
}
