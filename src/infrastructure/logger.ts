import type * as vscode from "vscode";
import { redactText, redactUnknown } from "./redaction.js";

export interface Logger {
  info(message: string): void;
  error(message: string, error?: unknown): void;
  show(): void;
}

export class OutputChannelLogger implements Logger {
  public constructor(private readonly channel: vscode.OutputChannel) {}

  public info(message: string): void {
    this.channel.appendLine(
      `${new Date().toISOString()} INFO ${redactText(message)}`,
    );
  }

  public error(message: string, error?: unknown): void {
    const detail = error === undefined ? "" : `: ${redactUnknown(error)}`;
    this.channel.appendLine(
      `${new Date().toISOString()} ERROR ${redactText(message)}${detail}`,
    );
  }

  public show(): void {
    this.channel.show(true);
  }
}
