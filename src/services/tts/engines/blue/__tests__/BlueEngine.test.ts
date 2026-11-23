import {NativeModules, Platform} from 'react-native';
import {BlueEngine, BLUE_VOICES, validateBlueURL} from '../index';

jest.mock('react-native', () => ({
  Platform: {OS: 'ios'},
  NativeModules: {BlueSpeech: {play: jest.fn().mockResolvedValue(undefined), stop: jest.fn().mockResolvedValue(undefined)}},
}));

describe('BlueTTS server speech', () => {
  const engine = new BlueEngine();
  beforeEach(() => {
    jest.clearAllMocks();
    BlueEngine.serverURL = 'https://speech.example.com';
    (Platform as {OS: string}).OS = 'ios';
  });
  it('rejects credentials, non-private HTTP, and endpoint URLs', () => {
    expect(() => validateBlueURL('https://user:pass@example.com')).toThrow();
    expect(() => validateBlueURL('http://speech.example.com')).toThrow();
    expect(() => validateBlueURL('https://example.com/v1/audio/speech')).toThrow();
    expect(validateBlueURL(' http://192.168.1.7:8000/ ')).toBe('http://192.168.1.7:8000');
  });
  it('passes user-selected voice and text to native playback', async () => {
    await engine.play('hello', BLUE_VOICES[1]);
    expect(NativeModules.BlueSpeech.play).toHaveBeenCalledWith('https://speech.example.com', 'hello', 'noa');
  });
  it('buffers stream and cancels pending speech', async () => {
    const stream = engine.playStreaming(BLUE_VOICES[0]);
    stream.appendText('first ');
    stream.appendText('second');
    await stream.finalize();
    expect(NativeModules.BlueSpeech.play).toHaveBeenCalledWith('https://speech.example.com', 'first second', 'maya');
    const other = engine.playStreaming(BLUE_VOICES[0]);
    other.appendText('do not speak');
    await other.cancel();
    await other.finalize();
    expect(NativeModules.BlueSpeech.play).toHaveBeenCalledTimes(1);
    expect(NativeModules.BlueSpeech.stop).toHaveBeenCalled();
  });
  it('rejects unsupported platform and invalid voice', async () => {
    await expect(engine.play('hi', {id: 'fake', name: 'Fake', engine: 'blue'})).rejects.toThrow('Unknown');
    (Platform as {OS: string}).OS = 'android';
    await expect(engine.play('hi', BLUE_VOICES[0])).rejects.toThrow('iOS');
  });
});
