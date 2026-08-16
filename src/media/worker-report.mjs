import { safeLimitations } from "./worker-state.mjs";

export function courseSummary({ course, queuePath, queue, processed, discovery }) {
  const counts = countQueue(queue);
  const limitation = queue
    .flatMap((job) => safeLimitations(job.limitations, job.limitation))
    .find(Boolean);
  return {
    key: course.key,
    courseId: course.courseId,
    queuePath,
    discoveryVerdict: discovery.verdict ?? "red",
    total: queue.length,
    processed,
    ...counts,
    ...(limitation ? { limitation } : {}),
  };
}

export function missingQueueSummary(course, queuePath) {
  return {
    key: course.key,
    courseId: course.courseId,
    queuePath: queuePath ?? null,
    discoveryVerdict: "red",
    total: 0,
    processed: 0,
    queued: 0,
    active: 0,
    checkpointed: 0,
    completed: 0,
    failed: 1,
    withdrawn: 0,
    limitation: `No durable media queue exists for ${course.key}. Run: npm run media:discover -- ${course.key}`,
  };
}

export function discoveryIncompleteSummary(course, queuePath, record) {
  return {
    key: course.key,
    courseId: course.courseId,
    queuePath,
    discoveryVerdict: record.verdict ?? "red",
    total: 0,
    processed: 0,
    queued: 0,
    active: 0,
    checkpointed: 0,
    completed: 0,
    failed: 1,
    withdrawn: 0,
    limitation: (record.limitations ?? ["Media discovery is incomplete."])[0],
  };
}

export function queueReadFailureSummary(course, limitation) {
  return {
    key: course.key,
    courseId: course.courseId,
    queuePath: null,
    discoveryVerdict: "red",
    total: 0,
    processed: 0,
    queued: 0,
    active: 0,
    checkpointed: 0,
    completed: 0,
    failed: 1,
    withdrawn: 0,
    limitation,
  };
}

export function countQueue(queue) {
  return queue.reduce(
    (counts, job) => {
      if (job.withdrawn === true || job.stage === "withdrawn") counts.withdrawn += 1;
      else if (job.complete === true || job.stage === "complete") counts.completed += 1;
      else if (job.stage === "failed" || job.verdict === "red") counts.failed += 1;
      else if (job.stage === "checkpointed") counts.checkpointed += 1;
      else if (job.stage === "active") counts.active += 1;
      else counts.queued += 1;
      return counts;
    },
    { queued: 0, active: 0, checkpointed: 0, completed: 0, failed: 0, withdrawn: 0 },
  );
}

export function summarizeCounts(summaries) {
  return summaries.reduce(
    (counts, summary) => {
      for (const key of ["queued", "active", "checkpointed", "completed", "failed", "withdrawn"]) {
        counts[key] += summary[key] ?? 0;
      }
      counts.processed += summary.processed ?? 0;
      counts.total += summary.total ?? 0;
      return counts;
    },
    {
      total: 0,
      processed: 0,
      queued: 0,
      active: 0,
      checkpointed: 0,
      completed: 0,
      failed: 0,
      withdrawn: 0,
    },
  );
}

export function verdictFor({ summaries, counts, globalStop, stoppedAtBoundary }) {
  if (
    globalStop ||
    counts.failed ||
    summaries.some((summary) => summary.discoveryVerdict === "red")
  ) {
    return "red";
  }
  if (stoppedAtBoundary || counts.queued || counts.active || counts.checkpointed) return "yellow";
  return "green";
}

export function messageFor({ verdict, counts, globalStop, stoppedAtBoundary, summaries = [] }) {
  if (globalStop) return "Media queue stopped: global media safety failure; inspect the run log.";
  if (stoppedAtBoundary) {
    return `Media queue checkpointed at 04:00: ${counts.completed} complete, ${counts.queued + counts.checkpointed} remaining.`;
  }
  if (verdict === "red") {
    const limitation = summaries.find((summary) => summary.limitation)?.limitation;
    return `Media queue red: ${counts.failed} recording failure(s); ${
      limitation ? `first limitation: ${limitation}` : "retryable work remains queued."
    }`;
  }
  if (verdict === "yellow")
    return `Media queue pending: ${counts.queued + counts.checkpointed} recording(s) remain.`;
  return `Media queue complete: ${counts.completed} recording(s) complete.`;
}
