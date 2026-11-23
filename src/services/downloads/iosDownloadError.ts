/** Structured diagnostics for iOS model downloads. Never display native messages: they can contain signed URLs or file paths. */
export type IOSDownloadStage = 'mkdir' | 'temporary download' | 'final publish';

export class IOSDownloadStageError extends Error {
  readonly stage: IOSDownloadStage;
  readonly nativeDomain?: string;
  readonly nativeCode?: string;
  readonly underlyingDomain?: string;
  readonly underlyingCode?: string;
  readonly cause: unknown;

  constructor(stage: IOSDownloadStage, cause: unknown) {
    super(`iOS ${stage} failed`);
    this.name = 'IOSDownloadStageError';
    this.stage = stage;
    this.cause = cause;
    const native = cause as {domain?: unknown; code?: unknown; userInfo?: {NSUnderlyingError?: unknown; nativeDomain?: unknown; nativeCode?: unknown; underlyingDomain?: unknown; underlyingCode?: unknown}; underlyingError?: unknown} | null;
    const code = native?.code;
    // React Native's NSError conversion commonly uses "Domain:code" as its JS code.
    const match = typeof code === 'string' ? /^([A-Za-z][A-Za-z0-9.]+):(-?\d+)$/.exec(code) : null;
    this.nativeDomain = safeDomain(native?.userInfo?.nativeDomain) ?? safeDomain(native?.domain) ?? (match ? match[1] : undefined);
    this.nativeCode = safeCode(native?.userInfo?.nativeCode) ?? safeCode(match ? match[2] : code);
    const underlying = (native?.userInfo?.NSUnderlyingError ?? native?.underlyingError) as {domain?: unknown; code?: unknown} | undefined;
    this.underlyingDomain = safeDomain(native?.userInfo?.underlyingDomain) ?? safeDomain(underlying?.domain);
    this.underlyingCode = safeCode(native?.userInfo?.underlyingCode) ?? safeCode(underlying?.code);
  }
}

function safeDomain(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9.]{0,79}$/.test(value) ? value : undefined;
}
function safeCode(value: unknown): string | undefined {
  return (typeof value === 'number' && Number.isSafeInteger(value)) ||
    (typeof value === 'string' && /^-?\d{1,12}$/.test(value)) ? String(value) : undefined;
}

export function describeIOSDownloadError(error: IOSDownloadStageError): string {
  const detail = error.nativeCode
    ? ` (${error.nativeDomain ? `${error.nativeDomain} ` : ''}code ${error.nativeCode}${error.underlyingCode ? `; underlying ${error.underlyingDomain ? `${error.underlyingDomain} ` : ''}code ${error.underlyingCode}` : ''})`
    : '';
  const advice = error.nativeDomain === 'NSCocoaErrorDomain' && error.nativeCode === '640'
    ? 'Free up device storage and try again.'
    : error.stage === 'temporary download'
      ? 'Check your connection and available storage, then retry.'
      : 'Check available device storage and retry.';
  return `iOS ${error.stage} failed${detail}. ${advice}`;
}
