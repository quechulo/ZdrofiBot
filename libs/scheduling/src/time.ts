import { DateTime } from "luxon";

export const PORTAL_TIME_ZONE = "Europe/Warsaw";

const REGISTRATION_LEAD_HOURS = 48;
const LOCAL_FORMAT = "yyyy-MM-dd HH:mm";

/** Reads the portal's "YYYY-MM-DD HH:mm", which is always Warsaw time. */
export function parsePortalTime(local: string): Date {
  const parsed = DateTime.fromFormat(local, LOCAL_FORMAT, { zone: PORTAL_TIME_ZONE });
  if (!parsed.isValid) throw new Error(`Invalid portal time: ${local}`);
  return parsed.toJSDate();
}

/**
 * When registration opens for a class. The live schedule fits "48 elapsed hours
 * before the start", but that is unverified across a DST change, where it differs
 * by an hour from "same clock time two days earlier". Check in late March 2027.
 */
export function opensAt(startsAt: Date): Date {
  return new Date(startsAt.getTime() - REGISTRATION_LEAD_HOURS * 60 * 60 * 1000);
}
