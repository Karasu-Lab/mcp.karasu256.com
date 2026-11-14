import type { ToolDispatch } from '../lib/mcp/server';
import { avatarCommands } from './avatar';
import { deviceCommands } from './device';

export abstract class McpClientCommands {
  private readonly registered = new Map<string, ToolDispatch>();

  protected register(commands: ToolDispatch[]): void {
    for (const command of commands) this.registered.set(command.name, command);
  }

  list(): ToolDispatch[] {
    return [...this.registered.values()];
  }
}

export class ClaudeCommands extends McpClientCommands {
  constructor() {
    super();
    this.register(avatarCommands());
  }
}

export class MuseConnectorCommands extends McpClientCommands {
  constructor() {
    super();
    this.register(deviceCommands());
    this.register(avatarCommands());
  }
}
