export const JOB_STATES = [
  "SCHEDULED",
  "ARMED",
  "FIRING",
  "VERIFYING",
  "BOOKED",
  "WAITLISTED",
  "FULL",
  "FAILED",
  "MISSED",
  "CANCELLED",
] as const;

export type JobState = (typeof JOB_STATES)[number];
