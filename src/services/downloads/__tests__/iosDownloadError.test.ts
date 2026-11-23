import {IOSDownloadStageError, describeIOSDownloadError} from '../iosDownloadError';

describe('iOS download diagnostics', () => {
  it('preserves Cocoa and underlying POSIX codes without leaking signed URLs', () => {
    const native = Object.assign(new Error('https://host/model?token=SECRET'), {
      code: 'NSCocoaErrorDomain:640',
      userInfo: {NSUnderlyingError: {domain: 'NSPOSIXErrorDomain', code: 28}},
    });
    const error = new IOSDownloadStageError('temporary download', native);
    expect(error.cause).toBe(native);
    expect(error.nativeCode).toBe('640');
    expect(error.underlyingCode).toBe('28');
    expect(describeIOSDownloadError(error)).toContain('NSCocoaErrorDomain code 640');
    expect(describeIOSDownloadError(error)).toContain('NSPOSIXErrorDomain code 28');
    expect(describeIOSDownloadError(error)).not.toContain('SECRET');
  });

  it('never renders untrusted native codes or error messages', () => {
    const error = new IOSDownloadStageError('mkdir', {
      domain: 'https://host?token=SECRET', code: 'https://host?token=SECRET',
      message: 'Cannot create file https://host?token=SECRET',
    });
    expect(describeIOSDownloadError(error)).toBe('iOS mkdir failed. Check available device storage and retry.');
  });

  it('reports final publication independently of temporary download', () => {
    expect(describeIOSDownloadError(new IOSDownloadStageError('final publish', {
      domain: 'NSCocoaErrorDomain', code: 513,
    }))).toContain('iOS final publish failed (NSCocoaErrorDomain code 513)');
  });
});
