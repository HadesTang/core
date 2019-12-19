import { ElectronMainContribution } from '../types';
import { Domain, URI } from '@ali/ide-core-common';
import { protocol } from 'electron';
import { readFile } from 'fs-extra';

@Domain(ElectronMainContribution)
export class ProtocolElectronMainContribution implements ElectronMainContribution {

  onStart() {

    protocol.registerBufferProtocol('vscode-resource', async (req, callback: any) => {
      const { url } = req;
      const uri = new URI(url);
      try {
        const data = await readFile(uri.codeUri.fsPath);
        callback({ mimeType: 'raw', data});
      } catch (e) {
        callback({ error: -2});
      }
    });
  }

  beforeAppReady() {
    if (protocol.registerSchemesAsPrivileged) {
      // 旧版本electron可能没有这个api
      protocol.registerSchemesAsPrivileged([{
        scheme: 'vscode-resource',
      }]);
    }
  }

}