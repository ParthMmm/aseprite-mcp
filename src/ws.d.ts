// Minimal types for the parts of "ws" this project uses; the package ships none.
declare module "ws" {
  import { EventEmitter } from "node:events";

  export class WebSocket extends EventEmitter {
    static readonly OPEN: number;
    readonly OPEN: number;
    readyState: number;
    send(data: string | Uint8Array, callback?: (error?: Error) => void): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
  }

  export class WebSocketServer extends EventEmitter {
    constructor(options: { host?: string; port?: number; maxPayload?: number });
    clients: Set<WebSocket>;
    address(): { port: number } | string | null;
    close(callback?: (error?: Error) => void): void;
  }
}
