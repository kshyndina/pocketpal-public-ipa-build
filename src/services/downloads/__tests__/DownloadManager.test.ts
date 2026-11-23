import {IOSDownloadStageError} from '../iosDownloadError';
import {NativeModules, Platform, NativeEventEmitter} from 'react-native';

import * as RNFS from '@dr.pogodin/react-native-fs';

import {basicModel} from '../../../../jest/fixtures/models';

import {DownloadManager, DownloadCancelledError} from '../DownloadManager';
import {ensureNotificationPermission} from '../../../utils/androidPermission';

jest.mock('../../../utils/androidPermission', () => ({
  ensureNotificationPermission: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('react-native', () => {
  // Create a shared mock for DownloadModule inside the factory
  const mockDownloadModule = {
    startDownload: jest.fn(),
    cancelDownload: jest.fn(),
    getActiveDownloads: jest.fn(),
    reattachDownloadObserver: jest.fn(),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
    pauseDownload: jest.fn(),
    resumeDownload: jest.fn(),
    retryDownload: jest.fn(),
    logDownloadDatabase: jest.fn(),
  };

  return {
    NativeModules: {
      DownloadModule: mockDownloadModule,
    },
    NativeEventEmitter: jest.fn(),
    Platform: {
      OS: 'android',
    },
    Appearance: {
      getColorScheme: jest.fn(() => 'light'),
    },
    TurboModuleRegistry: {
      getEnforcing: jest.fn((name: string) => {
        if (name === 'DownloadModule') {
          return mockDownloadModule;
        }
        return null;
      }),
    },
  };
});

describe('DownloadManager', () => {
  let downloadManager: DownloadManager;
  let mockEventEmitter: any;

  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks retains mockResolvedValueOnce queues from previous cases.
    // Give each download an isolated filesystem state.
    (RNFS.exists as jest.Mock).mockReset().mockResolvedValue(false);
    (RNFS.stat as jest.Mock).mockReset().mockResolvedValue({size: 1, isFile: () => true});
    (RNFS.moveFile as jest.Mock).mockReset().mockResolvedValue(undefined);

    // Setup mock event emitter
    mockEventEmitter = {
      addListener: jest.fn(),
      removeAllListeners: jest.fn(),
    };
    (NativeEventEmitter as jest.Mock).mockReturnValue(mockEventEmitter);

    // Reset platform to Android by default
    (Platform as any).OS = 'android';

    downloadManager = new DownloadManager();
  });

  it('initializes correctly', () => {
    expect(downloadManager).toBeDefined();
    expect(NativeEventEmitter).toHaveBeenCalled();
    expect(mockEventEmitter.addListener).toHaveBeenCalledWith(
      'onDownloadProgress',
      expect.any(Function),
    );
    expect(mockEventEmitter.addListener).toHaveBeenCalledWith(
      'onDownloadComplete',
      expect.any(Function),
    );
    expect(mockEventEmitter.addListener).toHaveBeenCalledWith(
      'onDownloadFailed',
      expect.any(Function),
    );
  });

  it('starts a download on Android', async () => {
    NativeModules.DownloadModule.startDownload.mockResolvedValue({
      downloadId: 'download123',
    });

    const callbacks = {
      onStart: jest.fn(),
      onProgress: jest.fn(),
      onComplete: jest.fn(),
      onError: jest.fn(),
    };

    downloadManager.setCallbacks(callbacks);

    await downloadManager.startDownload(basicModel, '/path/to/model.bin');

    expect(RNFS.mkdir).toHaveBeenCalledWith('/path/to');
    expect(NativeModules.DownloadModule.startDownload).toHaveBeenCalledWith(
      basicModel.downloadUrl,
      expect.objectContaining({
        destination: '/path/to/model.bin',
      }),
    );
    expect(callbacks.onStart).toHaveBeenCalledWith('model-1');
    expect(downloadManager.isDownloading('model-1')).toBe(true);
  });

  it('asks for notification permission before starting on Android', async () => {
    const order: string[] = [];
    (ensureNotificationPermission as jest.Mock).mockImplementation(async () => {
      order.push('permission');
    });
    NativeModules.DownloadModule.startDownload.mockImplementation(async () => {
      order.push('start');
      return {downloadId: 'download123'};
    });

    await downloadManager.startDownload(basicModel, '/path/to/model.bin');

    expect(order).toEqual(['permission', 'start']);
  });

  it('passes the progress Android kept to onError on failure', async () => {
    NativeModules.DownloadModule.startDownload.mockResolvedValue({
      downloadId: 'download123',
    });
    const onError = jest.fn();
    downloadManager.setCallbacks({onError});
    await downloadManager.startDownload(basicModel, '/path/to/model.bin');
    const [, emitFailure] = mockEventEmitter.addListener.mock.calls.find(
      ([name]: [string]) => name === 'onDownloadFailed',
    );

    emitFailure({downloadId: 'download123', error: 'stalled', progress: 40});

    expect(onError).toHaveBeenCalledWith('model-1', expect.any(Error), 40);
    expect(downloadManager.isDownloading('model-1')).toBe(false);
  });

  it('starts a download on iOS', async () => {
    (Platform as any).OS = 'ios';

    const mockDownloadResult = {
      jobId: 123,
      promise: Promise.resolve({statusCode: 200}),
    };

    (RNFS.downloadFile as jest.Mock).mockReturnValue(mockDownloadResult);

    const callbacks = {
      onStart: jest.fn(),
      onProgress: jest.fn(),
      onComplete: jest.fn(),
      onError: jest.fn(),
    };

    downloadManager.setCallbacks(callbacks);

    await downloadManager.startDownload(basicModel, '/path/to/model.bin');

    expect(RNFS.mkdir).toHaveBeenCalledWith('/path/to');
    expect(RNFS.downloadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        fromUrl: basicModel.downloadUrl,
        toFile: '/path/to/model.bin.download',
      }),
    );

    expect(callbacks.onComplete).toHaveBeenCalledWith('model-1');
    expect(downloadManager.isDownloading('model-1')).toBe(false);
  });

  it('cancels a download', async () => {
    // Setup a download first
    NativeModules.DownloadModule.startDownload.mockResolvedValue({
      downloadId: 'download123',
    });

    await downloadManager.startDownload(basicModel, '/path/to/model.bin');
    expect(downloadManager.isDownloading('model-1')).toBe(true);

    // Now cancel it
    await downloadManager.cancelDownload('model-1');

    expect(NativeModules.DownloadModule.cancelDownload).toHaveBeenCalledWith(
      'download123',
    );
    expect(downloadManager.isDownloading('model1')).toBe(false);
  });

  it('syncs with active downloads', async () => {
    NativeModules.DownloadModule.getActiveDownloads.mockResolvedValue([
      {
        id: 'download123',
        url: basicModel.downloadUrl,
        destination: '/path/to/model.bin',
        bytesWritten: 500000,
        totalBytes: 1000000,
        progress: 50,
      },
    ]);

    const callbacks = {
      onStart: jest.fn(),
    };

    downloadManager.setCallbacks(callbacks);

    await downloadManager.syncWithActiveDownloads([basicModel]);

    expect(NativeModules.DownloadModule.getActiveDownloads).toHaveBeenCalled();
    expect(downloadManager.isDownloading('model-1')).toBe(true);
    expect(downloadManager.getDownloadProgress('model-1')).toBe(50);
    expect(callbacks.onStart).toHaveBeenCalledWith('model-1');
  });

  it('handles download progress events', async () => {
    // Setup a download first
    NativeModules.DownloadModule.startDownload.mockResolvedValue({
      downloadId: 'download123',
    });

    const callbacks = {
      onStart: jest.fn(),
      onProgress: jest.fn(),
    };

    downloadManager.setCallbacks(callbacks);

    // Start download and wait for it to complete
    await downloadManager.startDownload(basicModel, '/path/to/model.bin');

    // Verify the download job was created
    expect(downloadManager.isDownloading('model-1')).toBe(true);

    // Get the progress listener directly from the mock
    const progressListener = mockEventEmitter.addListener.mock.calls.find(
      call => call[0] === 'onDownloadProgress',
    )[1];

    // Call the progress listener with a mock event that matches model ID
    progressListener({
      downloadId: 'download123',
      bytesWritten: 500000,
      totalBytes: 1000000,
      progress: 50,
    });

    // Now check if onProgress was called
    expect(callbacks.onProgress).toHaveBeenCalledWith(
      'model-1', // Make sure this matches model ID
      expect.objectContaining({
        bytesDownloaded: 500000,
        bytesTotal: 1000000,
        progress: 50,
      }),
    );
  });

  it('starts and manages a download on iOS', async () => {
    // Set platform to iOS
    (Platform as any).OS = 'ios';

    // Create a new instance for iOS testing
    const iosDownloadManager = new DownloadManager();

    const callbacks = {
      onStart: jest.fn(),
      onProgress: jest.fn(),
      onComplete: jest.fn(),
      onError: jest.fn(),
    };

    iosDownloadManager.setCallbacks(callbacks);

    let beginCallback: any;
    let progressCallback: any;

    let completeDownload: (result: {statusCode: number; bytesWritten: number}) => void = () => {};
    const mockDownloadResult = {
      jobId: 456,
      promise: new Promise<{statusCode: number; bytesWritten: number}>(resolve => {
        completeDownload = resolve;
      }),
    };

    (RNFS.downloadFile as jest.Mock).mockImplementation(options => {
      // Save the callbacks so we can call them manually
      beginCallback = options.begin;
      progressCallback = options.progress;
      return mockDownloadResult;
    });

    (RNFS.stat as jest.Mock).mockResolvedValueOnce({size: 1000000, isFile: () => true});
    // Start the download
    const downloadPromise = iosDownloadManager.startDownload(
      basicModel,
      '/path/to/model.bin',
    );

    await new Promise(resolve => setImmediate(resolve));

    expect(RNFS.mkdir).toHaveBeenCalledWith('/path/to');

    expect(RNFS.downloadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        fromUrl: basicModel.downloadUrl,
        toFile: '/path/to/model.bin.download',
        discretionary: false,
      }),
    );

    expect(iosDownloadManager.isDownloading('model-1')).toBe(true);

    // Simulate begin callback
    beginCallback({
      statusCode: 200,
      contentLength: 1000000,
      headers: {},
    });

    expect(callbacks.onStart).toHaveBeenCalledWith('model-1');
    expect(callbacks.onProgress).toHaveBeenCalledWith(
      'model-1',
      expect.objectContaining({
        bytesDownloaded: 0,
        bytesTotal: 1000000,
        progress: 0,
      }),
    );

    // Reset mock to check next call
    callbacks.onProgress.mockClear();

    // Simulate progress callback (50%)
    progressCallback({
      bytesWritten: 500000,
      contentLength: 1000000,
    });

    expect(callbacks.onProgress).toHaveBeenCalledWith(
      'model-1',
      expect.objectContaining({
        bytesDownloaded: 500000,
        bytesTotal: 1000000,
        progress: 50,
      }),
    );

    // Complete only after begin/progress callbacks have been asserted.
    completeDownload({statusCode: 200, bytesWritten: 1000000});
    await downloadPromise;

    expect(RNFS.moveFile).toHaveBeenCalledWith('/path/to/model.bin.download', '/path/to/model.bin');
    expect(callbacks.onComplete).toHaveBeenCalledWith('model-1');
    expect(iosDownloadManager.isDownloading('model-1')).toBe(false);
  });

  it('rejects an incomplete iOS file and cleans staging without publishing', async () => {
    (Platform as any).OS = 'ios';
    const manager = new DownloadManager();
    const onError = jest.fn();
    const onComplete = jest.fn();
    manager.setCallbacks({onError, onComplete});
    (RNFS.downloadFile as jest.Mock).mockReturnValue({
      jobId: 900, promise: Promise.resolve({statusCode: 200, bytesWritten: 100}),
    });
    (RNFS.stat as jest.Mock).mockResolvedValueOnce({size: 50, isFile: () => true});
    (RNFS.exists as jest.Mock).mockResolvedValue(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(manager.startDownload(basicModel, '/path/to/model.bin'))
      .rejects.toThrow('Incomplete model download');
    expect(RNFS.moveFile).not.toHaveBeenCalled();
    expect(RNFS.unlink).toHaveBeenCalledWith('/path/to/model.bin.download');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('preserves native iOS move error code and cleans staging', async () => {
    (Platform as any).OS = 'ios';
    const manager = new DownloadManager();
    const nativeError = Object.assign(new Error('No space left on device'), {
      code: 'NSCocoaErrorDomain:640',
    });
    const onError = jest.fn();
    manager.setCallbacks({onError});
    (RNFS.downloadFile as jest.Mock).mockReturnValue({
      jobId: 901, promise: Promise.reject(nativeError),
    });
    (RNFS.exists as jest.Mock).mockResolvedValue(false).mockResolvedValueOnce(true);
    await expect(manager.startDownload(basicModel, '/path/to/model.bin'))
      .rejects.toMatchObject({stage: 'temporary download', cause: nativeError, nativeCode: '640'});
    expect(onError).toHaveBeenCalledWith('model-1', expect.any(IOSDownloadStageError));
    expect(RNFS.unlink).toHaveBeenCalledWith('/path/to/model.bin.download');
  });

  it('identifies mkdir failures before creating a download task', async () => {
    (Platform as any).OS = 'ios';
    const native = Object.assign(new Error('Cannot create file'), {code: 'NSCocoaErrorDomain:513'});
    (RNFS.mkdir as jest.Mock).mockRejectedValueOnce(native);
    await expect(new DownloadManager().startDownload(basicModel, '/path/to/model.bin'))
      .rejects.toMatchObject({stage: 'mkdir', cause: native, nativeCode: '513'});
    expect(RNFS.downloadFile).not.toHaveBeenCalled();
  });

  it('identifies final publication failures without reporting completion', async () => {
    (Platform as any).OS = 'ios';
    const native = Object.assign(new Error('Move failed'), {code: 'NSCocoaErrorDomain:640'});
    const onError = jest.fn();
    const onComplete = jest.fn();
    const manager = new DownloadManager();
    manager.setCallbacks({onError, onComplete});
    (RNFS.downloadFile as jest.Mock).mockReturnValue({jobId: 903,
      promise: Promise.resolve({statusCode: 200, bytesWritten: 12})});
    (RNFS.stat as jest.Mock).mockResolvedValueOnce({size: 12, isFile: () => true});
    (RNFS.moveFile as jest.Mock).mockRejectedValueOnce(native);
    await expect(manager.startDownload(basicModel, '/path/to/model.bin'))
      .rejects.toMatchObject({stage: 'final publish', cause: native, nativeCode: '640'});
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('model-1', expect.any(IOSDownloadStageError));
  });

  it('removes stale staging before retry, then publishes valid bytes', async () => {
    (Platform as any).OS = 'ios';
    const manager = new DownloadManager();
    (RNFS.exists as jest.Mock).mockResolvedValueOnce(true);
    (RNFS.downloadFile as jest.Mock).mockReturnValue({
      jobId: 902, promise: Promise.resolve({statusCode: 200, bytesWritten: 12}),
    });
    (RNFS.stat as jest.Mock).mockResolvedValueOnce({size: 12, isFile: () => true});
    await manager.startDownload(basicModel, '/path/to/model.bin');
    expect(RNFS.unlink).toHaveBeenCalledWith('/path/to/model.bin.download');
    expect(RNFS.moveFile).toHaveBeenCalledWith('/path/to/model.bin.download', '/path/to/model.bin');
  });

  it('handles download failure on iOS', async () => {
    // Set platform to iOS
    (Platform as any).OS = 'ios';

    const iosDownloadManager = new DownloadManager();

    const callbacks = {
      onStart: jest.fn(),
      onProgress: jest.fn(),
      onComplete: jest.fn(),
      onError: jest.fn(),
    };

    iosDownloadManager.setCallbacks(callbacks);

    const mockDownloadResult = {
      jobId: 789,
      promise: Promise.resolve({statusCode: 404}), // Error status
    };

    (RNFS.downloadFile as jest.Mock).mockReturnValue(mockDownloadResult);

    await expect(
      iosDownloadManager.startDownload(basicModel, '/path/to/model.bin'),
    ).rejects.toThrow('Download failed with status: 404');

    expect(callbacks.onError).toHaveBeenCalledWith(
      'model-1',
      expect.any(Error),
    );

    expect(iosDownloadManager.isDownloading('model-1')).toBe(false);
  });

  it('does not surface an error when an iOS download is cancelled', async () => {
    (Platform as any).OS = 'ios';

    const iosDownloadManager = new DownloadManager();

    const callbacks = {
      onStart: jest.fn(),
      onProgress: jest.fn(),
      onComplete: jest.fn(),
      onError: jest.fn(),
    };

    iosDownloadManager.setCallbacks(callbacks);

    // A cancel aborts the RNFS task, rejecting the download promise.
    let rejectDownload: (reason: Error) => void = () => {};
    const downloadPromise = new Promise((_resolve, reject) => {
      rejectDownload = reject;
    });

    (RNFS.downloadFile as jest.Mock).mockReturnValue({
      jobId: 321,
      promise: downloadPromise,
    });

    const startPromise = iosDownloadManager.startDownload(
      basicModel,
      '/path/to/model.bin',
    );

    // Let the async setup (mkdir, job registration) settle before cancelling.
    await new Promise(resolve => setImmediate(resolve));

    expect(iosDownloadManager.isDownloading('model-1')).toBe(true);

    // User taps Stop, then the aborted task rejects the download promise.
    await iosDownloadManager.cancelDownload('model-1');
    rejectDownload(new Error('Download has been aborted'));

    // The cancel surfaces as a distinct DownloadCancelledError (not a generic
    // failure), so onError is never called and callers can special-case it.
    await expect(startPromise).rejects.toBeInstanceOf(DownloadCancelledError);

    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(iosDownloadManager.isDownloading('model-1')).toBe(false);
  });

  it('still surfaces an error for a genuine iOS download failure', async () => {
    (Platform as any).OS = 'ios';

    const iosDownloadManager = new DownloadManager();

    const callbacks = {
      onStart: jest.fn(),
      onProgress: jest.fn(),
      onComplete: jest.fn(),
      onError: jest.fn(),
    };

    iosDownloadManager.setCallbacks(callbacks);

    (RNFS.downloadFile as jest.Mock).mockReturnValue({
      jobId: 654,
      promise: Promise.reject(new Error('Network connection lost')),
    });

    await expect(
      iosDownloadManager.startDownload(basicModel, '/path/to/model.bin'),
    ).rejects.toThrow('iOS temporary download failed');

    expect(callbacks.onError).toHaveBeenCalledWith(
      'model-1',
      expect.any(Error),
    );
    expect(iosDownloadManager.isDownloading('model-1')).toBe(false);
  });

  it('still surfaces a later genuine failure after the same model was cancelled', async () => {
    (Platform as any).OS = 'ios';

    const iosDownloadManager = new DownloadManager();

    const callbacks = {
      onStart: jest.fn(),
      onProgress: jest.fn(),
      onComplete: jest.fn(),
      onError: jest.fn(),
    };

    iosDownloadManager.setCallbacks(callbacks);

    // First attempt: user cancels mid-download.
    let rejectFirst: (reason: Error) => void = () => {};
    const firstPromise = new Promise((_resolve, reject) => {
      rejectFirst = reject;
    });
    (RNFS.downloadFile as jest.Mock).mockReturnValueOnce({
      jobId: 111,
      promise: firstPromise,
    });

    const firstStart = iosDownloadManager.startDownload(
      basicModel,
      '/path/to/model.bin',
    );
    await new Promise(resolve => setImmediate(resolve));
    await iosDownloadManager.cancelDownload('model-1');
    rejectFirst(new Error('Download has been aborted'));
    await expect(firstStart).rejects.toBeInstanceOf(DownloadCancelledError);
    expect(callbacks.onError).not.toHaveBeenCalled();

    // Second attempt for the SAME model genuinely fails. The cancelled-id
    // marker from the first attempt must not swallow this real failure.
    (RNFS.downloadFile as jest.Mock).mockReturnValueOnce({
      jobId: 222,
      promise: Promise.reject(new Error('Network connection lost')),
    });

    await expect(
      iosDownloadManager.startDownload(basicModel, '/path/to/model.bin'),
    ).rejects.toThrow('iOS temporary download failed');

    expect(callbacks.onError).toHaveBeenCalledWith(
      'model-1',
      expect.any(Error),
    );
    expect(iosDownloadManager.isDownloading('model-1')).toBe(false);
  });

  it('sends the attribution User-Agent on the iOS RNFS download', async () => {
    (Platform as any).OS = 'ios';

    const iosDownloadManager = new DownloadManager();
    iosDownloadManager.setCallbacks({
      onStart: jest.fn(),
      onProgress: jest.fn(),
      onComplete: jest.fn(),
      onError: jest.fn(),
    });

    (RNFS.downloadFile as jest.Mock).mockReturnValue({
      jobId: 999,
      promise: Promise.resolve({statusCode: 200}),
    });

    await iosDownloadManager.startDownload(basicModel, '/path/to/model.bin');

    expect(RNFS.downloadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          'User-Agent': 'PocketPal/1.0.0 (ai.pocketpal)',
        }),
      }),
    );
  });

  it('attaches the HF auth token only for a huggingface.co download URL (iOS)', async () => {
    (Platform as any).OS = 'ios';

    const iosDownloadManager = new DownloadManager();
    iosDownloadManager.setCallbacks({
      onStart: jest.fn(),
      onProgress: jest.fn(),
      onComplete: jest.fn(),
      onError: jest.fn(),
    });

    (RNFS.downloadFile as jest.Mock).mockReturnValue({
      jobId: 1001,
      promise: Promise.resolve({statusCode: 200}),
    });

    await iosDownloadManager.startDownload(
      basicModel,
      '/path/to/model.bin',
      'secret-token',
    );

    expect(RNFS.downloadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer secret-token',
        }),
      }),
    );
  });

  it('does not attach the HF auth token for a non-huggingface.co URL (iOS)', async () => {
    (Platform as any).OS = 'ios';

    const iosDownloadManager = new DownloadManager();
    iosDownloadManager.setCallbacks({
      onStart: jest.fn(),
      onProgress: jest.fn(),
      onComplete: jest.fn(),
      onError: jest.fn(),
    });

    (RNFS.downloadFile as jest.Mock).mockReturnValue({
      jobId: 1002,
      promise: Promise.resolve({statusCode: 200}),
    });

    const offHostModel = {
      ...basicModel,
      id: 'off-host-model',
      downloadUrl: 'https://evil.example.com/test/test-model-1',
    };

    await iosDownloadManager.startDownload(
      offHostModel,
      '/path/to/model.bin',
      'secret-token',
    );

    const headers = (RNFS.downloadFile as jest.Mock).mock.calls[0][0].headers;
    expect(headers.Authorization).toBeUndefined();
  });

  it('does not forward the HF auth token to the native module for a non-HF URL (Android)', async () => {
    NativeModules.DownloadModule.startDownload.mockResolvedValue({
      downloadId: 'download-off-host',
    });

    const offHostModel = {
      ...basicModel,
      id: 'off-host-model',
      downloadUrl: 'https://evil.example.com/test/test-model-1',
    };

    await downloadManager.startDownload(
      offHostModel,
      '/path/to/model.bin',
      'secret-token',
    );

    const config = NativeModules.DownloadModule.startDownload.mock.calls[0][1];
    expect(config.authToken).toBeUndefined();
  });
});
