import * as RNFS from '@dr.pogodin/react-native-fs';
import {keepLocalCopy, pick, errorCodes, isErrorWithCode, types} from '@react-native-documents/picker';
import {Platform} from 'react-native';
import {v4 as uuidv4} from 'uuid';
import {isSafePathSegment} from './pathGuard';

/** The picker grants temporary access to provider URLs. Materialize them with
 * NSFileCoordinator (keepLocalCopy) before touching them with RNFS. */
export async function pickGGUF() {
  try {
    const [file] = await pick({type: Platform.OS === 'ios' ? 'public.data' : types.allFiles});
    return file || null;
  } catch (error) {
    if (isErrorWithCode(error) && error.code === errorCodes.OPERATION_CANCELED) {
      return null;
    }
    throw error;
  }
}

export async function importGGUF(
  file: {uri: string; name: string | null; size?: number | null},
  register: (path: string) => Promise<void>,
): Promise<string> {
  const name = file.name;
  if (!name || !isSafePathSegment(name, {allowBackslash: false}) ||
      !name.toLowerCase().endsWith('.gguf')) {
    throw new Error('Choose a .gguf model file with a valid filename.');
  }
  const dir = `${RNFS.DocumentDirectoryPath}/models/local`;
  const target = `${dir}/${uuidv4()}_${name}`;
  const staged = `${target}.importing`;
  let source: string | undefined;
  try {
    await RNFS.mkdir(dir);
    if (Platform.OS === 'ios') {
      const [copy] = await keepLocalCopy({
        files: [{uri: file.uri, fileName: name}],
        destination: 'cachesDirectory',
      });
      if (copy.status !== 'success' || !copy.localUri) {
        throw new Error(`Files could not provide a local copy: ${copy.status === 'error' ? copy.copyError : 'no file returned'}`);
      }
      source = decodeURI(copy.localUri.replace(/^file:\/\//, ''));
    } else {
      source = file.uri;
    }
    await RNFS.copyFile(source, staged);
    const stat = await RNFS.stat(staged);
    const actual = Number(stat.size);
    if (!Number.isFinite(actual) || actual <= 0) {
      throw new Error('The copied GGUF is empty. Check the source file in Files.');
    }
    if (file.size != null && file.size > 0 && actual !== file.size) {
      throw new Error(`Incomplete GGUF copy: expected ${file.size} bytes, got ${actual} bytes.`);
    }
    await RNFS.moveFile(staged, target);
    await register(target);
    return target;
  } catch (error) {
    for (const path of [staged, target]) {
      if (await RNFS.exists(path)) {
        try { await RNFS.unlink(path); } catch (cleanupError) {
          console.warn('Unable to remove incomplete GGUF import', cleanupError);
        }
      }
    }
    throw error;
  } finally {
    if (Platform.OS === 'ios' && source && await RNFS.exists(source)) {
      try { await RNFS.unlink(source); } catch (error) {
        console.warn('Unable to remove temporary Files copy', error);
      }
    }
  }
}
