export function positiveDuration(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function durationLabel(value) {
  const duration = positiveDuration(value);
  return duration === null ? "unavailable" : `${duration.toFixed(1)}s`;
}
