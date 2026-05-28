import * as vscode from 'vscode';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVELS: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export class Logger {
  private channel: vscode.OutputChannel;
  private level: LogLevel;

  constructor(channelName: string, level: LogLevel) {
    this.channel = vscode.window.createOutputChannel(channelName);
    this.level = level;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private write(level: LogLevel, msg: string, extra?: unknown): void {
    if (LEVELS[level] > LEVELS[this.level]) return;
    const ts = new Date().toISOString();
    const tail = extra === undefined ? '' : ' ' + safeStringify(extra);
    this.channel.appendLine(`[${ts}] ${level.toUpperCase()} ${msg}${tail}`);
  }

  error(msg: string, extra?: unknown): void { this.write('error', msg, extra); }
  warn(msg: string, extra?: unknown): void { this.write('warn', msg, extra); }
  info(msg: string, extra?: unknown): void { this.write('info', msg, extra); }
  debug(msg: string, extra?: unknown): void { this.write('debug', msg, extra); }

  show(): void { this.channel.show(); }
  dispose(): void { this.channel.dispose(); }
}

function safeStringify(value: unknown): string {
  try {
    if (value instanceof Error) return `${value.message}\n${value.stack ?? ''}`;
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
