import * as vscode from 'vscode';
import { DebugAdapterSessionImpl } from '@ali/ide-debug/lib/node';
import { DebugStreamConnection, DebugConfiguration } from '@ali/ide-debug';
import { IWebSocket } from '@ali/ide-connection';

export class ExtensionDebugAdapterSession extends DebugAdapterSessionImpl implements vscode.DebugSession {
  readonly type: string;
  readonly name: string;
  readonly workspaceFolder: vscode.WorkspaceFolder | undefined;
  readonly configuration: DebugConfiguration;

  constructor(
    protected readonly communicationProvider: DebugStreamConnection,
    protected readonly tracker: vscode.DebugAdapterTracker,
    protected readonly debugSession: vscode.DebugSession) {

    super(debugSession.id, communicationProvider);

    this.type = debugSession.type;
    this.name = debugSession.name;
    this.workspaceFolder = debugSession.workspaceFolder;
    this.configuration = debugSession.configuration;
  }

  async start(channel: IWebSocket): Promise<void> {
    if (this.tracker.onWillStartSession) {
      this.tracker.onWillStartSession();
    }
    await super.start(channel);
  }

  async stop(): Promise<void> {
    if (this.tracker.onWillStopSession) {
      this.tracker.onWillStopSession();
    }
    await super.stop();
  }

  async customRequest(command: string, args?: any): Promise<any> {
    return this.debugSession.customRequest(command, args);
  }

  protected onDebugAdapterError(error: Error): void {
    if (this.tracker.onError) {
      this.tracker.onError(error);
    }
    super.onDebugAdapterError(error);
  }

  protected send(message: string): void {
    try {
      super.send(message);
    } finally {
      if (this.tracker.onDidSendMessage) {
        this.tracker.onDidSendMessage(message);
      }
    }
  }

  protected write(message: string): void {
    if (this.tracker.onWillReceiveMessage) {
      this.tracker.onWillReceiveMessage(message);
    }
    super.write(message);
  }

  protected onDebugAdapterExit(exitCode: number, signal: string | undefined): void {
    if (this.tracker.onExit) {
      this.tracker.onExit(exitCode, signal);
    }
    super.onDebugAdapterExit(exitCode, signal);
  }
}
