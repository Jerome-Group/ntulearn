export function isMediaJobComplete(job) {
  return job?.complete === true && job?.transcript?.complete === true;
}
