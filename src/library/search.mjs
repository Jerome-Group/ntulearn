export function searchMaterials(materials, query = "", course = "") {
  const needle = query.toLowerCase();
  return materials
    .filter((material) => !course || material.course.toLowerCase() === course.toLowerCase())
    .flatMap((material) => {
      const text = material.text.state === "read" ? material.text.value : "";
      const textIndex = text.toLowerCase().indexOf(needle);
      const pathMatch = material.path.toLowerCase().includes(needle);
      if (!pathMatch && textIndex < 0) return [];
      const start = textIndex < 0 ? 0 : Math.max(0, textIndex - 70);
      const snippet = text
        ? `${start ? "…" : ""}${text.slice(start, start + 220).replace(/\s+/g, " ")}${text.length > start + 220 ? "…" : ""}`
        : material.text.state === "read"
          ? "Empty Markdown document."
          : material.text.state === "filename-only"
            ? "Attachment filename only. Contents were not read."
            : "Document text unavailable. Inspect the scan diagnostics.";
      return [{ ...material, match: needle && textIndex >= 0 ? "text" : "filename", snippet }];
    });
}
