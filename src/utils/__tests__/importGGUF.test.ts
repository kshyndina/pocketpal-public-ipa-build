import * as RNFS from '@dr.pogodin/react-native-fs';
import {keepLocalCopy, pick, errorCodes} from '@react-native-documents/picker';
import {importGGUF, pickGGUF} from '../importGGUF';

const file = {uri: 'file:///provider/model.gguf', name: 'model.gguf', size: 42};
const register = jest.fn().mockResolvedValue(undefined);

beforeEach(() => {
  jest.clearAllMocks();
  (RNFS.stat as jest.Mock).mockResolvedValue({size: 42});
  (RNFS.exists as jest.Mock).mockResolvedValue(false);
  (keepLocalCopy as jest.Mock).mockResolvedValue([{status: 'success', localUri: 'file:///cache/model.gguf'}]);
});

test('copies provider document through coordinator, verifies, then registers', async () => {
  await importGGUF(file, register);
  expect(keepLocalCopy).toHaveBeenCalledWith({files: [{uri: file.uri, fileName: file.name}], destination: 'cachesDirectory'});
  expect(RNFS.copyFile).toHaveBeenCalledWith('/cache/model.gguf', expect.stringMatching(/\.importing$/));
  expect(RNFS.moveFile).toHaveBeenCalled();
  expect(register).toHaveBeenCalledWith(expect.stringMatching(/models\/local\/.*model\.gguf$/));
});

test.each([0, 41])('rejects empty or truncated copy (%s bytes)', async size => {
  (RNFS.stat as jest.Mock).mockResolvedValue({size});
  await expect(importGGUF(file, register)).rejects.toThrow(size ? 'Incomplete' : 'empty');
  expect(RNFS.moveFile).not.toHaveBeenCalled();
  expect(register).not.toHaveBeenCalled();
});

test('rolls back final file if registration fails', async () => {
  (RNFS.exists as jest.Mock).mockResolvedValue(true);
  register.mockRejectedValueOnce(new Error('registration failed'));
  await expect(importGGUF(file, register)).rejects.toThrow('registration failed');
  expect(RNFS.unlink).toHaveBeenCalledWith(expect.stringMatching(/models\/local\/.*model\.gguf$/));
});

test('rejects traversal and non-GGUF names before copying', async () => {
  await expect(importGGUF({...file, name: '../bad.gguf'}, register)).rejects.toThrow();
  await expect(importGGUF({...file, name: 'notes.txt'}, register)).rejects.toThrow();
  expect(keepLocalCopy).not.toHaveBeenCalled();
});

test('picker cancel is quiet, other picker errors propagate', async () => {
  (pick as jest.Mock).mockRejectedValueOnce({code: errorCodes.OPERATION_CANCELED});
  await expect(pickGGUF()).resolves.toBeNull();
  (pick as jest.Mock).mockRejectedValueOnce(new Error('Files unavailable'));
  await expect(pickGGUF()).rejects.toThrow('Files unavailable');
});
