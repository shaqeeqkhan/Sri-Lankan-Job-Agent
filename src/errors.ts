export type ErrorCode =
  | 'INVALID_INPUT'
  | 'UNKNOWN_COMMAND'
  | 'NOT_FOUND'
  | 'NEEDS_FIELDS'
  | 'FETCH_FAILED'
  | 'CONFIG_INVALID'
  | 'FILE_REJECTED'
  /** A scanned PDF or photo: the agent must read the page images with its own vision. */
  | 'NEEDS_VISION'
  /** user/resume.md is missing: run `slj resume import` first. */
  | 'NO_RESUME'
  /** user/profile.yml is missing or invalid. */
  | 'NO_PROFILE'
  /** Every source in a scan failed. */
  | 'SCAN_FAILED'
  /** A tailored CV makes a claim that is not in resume.md or facts.yml. */
  | 'FACTCHECK_FAILED'
  /** HTML or PDF rendering failed. */
  | 'RENDER_FAILED'
  /** No usable Chrome / Edge / Chromium for the browser tiers or PDF printing. */
  | 'BROWSER_UNAVAILABLE'
  | 'INTERNAL';

/** An expected failure. Its code and details are returned to the agent as JSON. */
export class SljError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'SljError';
    this.code = code;
    this.details = details;
  }
}
