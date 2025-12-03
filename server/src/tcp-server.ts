import * as net from 'net';
import type { ServerConfig, ClientMessage, ServerMessage } from './types.js';

/**
 * Plain TCP server with newline-delimited JSON protocol
 * This is simpler than WebSocket and works directly with Neovim's vim.uv TCP client
 */
export class StrudelTcpServer {
  private server: net.Server | null = null;
  private clients: Set<net.Socket> = new Set();
  private messageHandler: ((msg: ClientMessage, socket: net.Socket) => void) | null = null;
  private disconnectHandler: (() => void) | null = null;
  private hasHadClient = false; // Track if we've ever had a client connect

  constructor(private config: ServerConfig) {}

  /**
   * Start the TCP server
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = net.createServer((socket) => {
          console.log('[strudel-server] Client connected');
          this.clients.add(socket);
          this.hasHadClient = true;

          let buffer = '';

          socket.on('data', (data) => {
            buffer += data.toString();

            // Process complete messages (newline-delimited)
            let newlineIndex;
            while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, newlineIndex);
              buffer = buffer.slice(newlineIndex + 1);

              if (line.trim()) {
                try {
                  const msg = JSON.parse(line) as ClientMessage;
                  if (this.messageHandler) {
                    this.messageHandler(msg, socket);
                  }
                } catch (err) {
                  console.error('[strudel-server] Failed to parse message:', err);
                }
              }
            }
          });

          socket.on('close', () => {
            console.log('[strudel-server] Client disconnected');
            this.clients.delete(socket);
            
            // If we've had a client before and now have none, notify
            if (this.hasHadClient && this.clients.size === 0 && this.disconnectHandler) {
              this.disconnectHandler();
            }
          });

          socket.on('error', (err) => {
            console.error('[strudel-server] Socket error:', err);
            this.clients.delete(socket);
            
            // If we've had a client before and now have none, notify
            if (this.hasHadClient && this.clients.size === 0 && this.disconnectHandler) {
              this.disconnectHandler();
            }
          });

          // Send initial status
          this.send(socket, {
            type: 'status',
            playing: false,
            paused: false,
            cycle: 0,
            cps: 1,
          });
        });

        this.server.on('error', (err) => {
          console.error('[strudel-server] Server error:', err);
          reject(err);
        });

        this.server.listen(this.config.port, this.config.host, () => {
          console.log(`[strudel-server] TCP server listening on ${this.config.host}:${this.config.port}`);
          resolve();
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Stop the TCP server
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        // Close all client connections
        for (const client of this.clients) {
          client.destroy();
        }
        this.clients.clear();

        this.server.close(() => {
          console.log('[strudel-server] Server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Register a message handler
   */
  onMessage(handler: (msg: ClientMessage, socket: net.Socket) => void): void {
    this.messageHandler = handler;
  }

  /**
   * Register a handler for when all clients disconnect
   * This is called when the last client disconnects (after at least one client has connected)
   */
  onAllClientsDisconnected(handler: () => void): void {
    this.disconnectHandler = handler;
  }

  /**
   * Send a message to a specific client
   */
  send(socket: net.Socket, msg: ServerMessage): void {
    if (!socket.destroyed) {
      socket.write(JSON.stringify(msg) + '\n');
    }
  }

  /**
   * Broadcast a message to all connected clients
   */
  broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg) + '\n';
    for (const client of this.clients) {
      if (!client.destroyed) {
        client.write(data);
      }
    }
  }

  /**
   * Get the number of connected clients
   */
  get clientCount(): number {
    return this.clients.size;
  }
}
