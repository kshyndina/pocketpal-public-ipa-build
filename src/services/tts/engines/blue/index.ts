import {NativeModules, Platform} from 'react-native';

import type {Engine, StreamOptions, StreamingHandle, Voice} from '../../types';

/** BlueTTS's OpenAI-compatible server; never stores credentials or sends auth headers. */
export const BLUE_VOICES: Voice[] = [
  'maya', 'noa', 'lily', 'tamar', 'shira', 'yael', 'emma', 'sara',
  'adam', 'daniel', 'david', 'jonathan', 'ethan', 'michael', 'ariel',
].map(id => ({id, name: id[0].toUpperCase() + id.slice(1), engine: 'blue' as const, requiresNetwork: true as const}));

export function validateBlueURL(value: string): string {
  const url = value.trim().replace(/\/+$/, '');
  // Explicit HTTPS is mandatory except loopback / LAN for self-hosting.
  if (!/^https?:\/\/[^/?#]+(?:\/[^?#]*)?$/i.test(url) ||
      /@/.test(url) || /\/(?:v1\/audio\/speech)\/?$/i.test(url)) {
    throw new Error('Enter a server base URL (not /v1/audio/speech), without credentials or query parameters.');
  }
  if (url.startsWith('http://') &&
      !/^http:\/\/(?:localhost|127\.0\.0\.1|10\.[0-9.]+|192\.168\.[0-9.]+|172\.(?:1[6-9]|2[0-9]|3[01])\.[0-9.]+)(?::\d+)?(?:\/|$)/i.test(url)) {
    throw new Error('Use HTTPS for public servers; HTTP is only allowed for private-network hosts.');
  }
  return url;
}

export class BlueEngine implements Engine {
  readonly id = 'blue' as const;
  /** Provided by the store so saved settings remain the only source of truth. */
  static serverURL = '';

  async isInstalled() { return Platform.OS === 'ios' && !!BlueEngine.serverURL; }
  async getVoices() { return BLUE_VOICES; }
  async loadInto() { /* Native AVAudioPlayer is independent of the neural speech module. */ }
  async play(text: string, voice: Voice) {
    if (Platform.OS !== 'ios') { throw new Error('BlueTTS server playback requires iOS.'); }
    const url = validateBlueURL(BlueEngine.serverURL);
    if (!BLUE_VOICES.some(v => v.id === voice.id)) { throw new Error('Unknown BlueTTS voice.'); }
    if (!text.trim()) { return; }
    await NativeModules.BlueSpeech.play(url, text, voice.id);
  }
  playStreaming(voice: Voice, waitFor?: Promise<void>, _opts?: StreamOptions): StreamingHandle {
    let buffer = '';
    let cancelled = false;
    return {
      appendText(chunk) { if (!cancelled) { buffer += chunk; } },
      finalize: async () => {
        if (cancelled) { return; }
        if (waitFor) { await waitFor; }
        if (!cancelled && buffer.trim()) { await this.play(buffer, voice); }
      },
      cancel: async () => { cancelled = true; await this.stop(); },
    };
  }
  async stop() { if (Platform.OS === 'ios') { await NativeModules.BlueSpeech.stop(); } }
}
