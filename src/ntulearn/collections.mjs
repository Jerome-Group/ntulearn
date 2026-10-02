import { absoluteUrl, isNtulearnUrl } from "./urls.mjs";

const MAX_COLLECTION_PAGES = 1_000;
const PAGINATION_FAILURE =
  "NTULearn collection pagination is invalid or exceeds its bound. Run the same command again; if it repeats, report an ntulearn defect.";

export async function readCollection(get, firstPage, { optional = false } = {}) {
  const results = [];
  const seen = new Set();
  let path = firstPage;
  while (path !== "") {
    if (typeof path !== "string" || !path.trim() || !isNtulearnUrl(path))
      throw new Error(PAGINATION_FAILURE);
    const address = absoluteUrl(path);
    if (seen.has(address) || seen.size >= MAX_COLLECTION_PAGES) throw new Error(PAGINATION_FAILURE);
    seen.add(address);
    const page = await get(path, { optional });
    if (page === null || typeof page !== "object" || Array.isArray(page))
      throw new Error(PAGINATION_FAILURE);
    if (page.unavailable === true) {
      if (!optional) throw new Error(PAGINATION_FAILURE);
      return { results: [], unavailable: true };
    }
    if (!Array.isArray(page.results)) throw new Error(PAGINATION_FAILURE);
    results.push(...page.results);
    path = page.paging?.nextPage ?? "";
  }
  return { results };
}
