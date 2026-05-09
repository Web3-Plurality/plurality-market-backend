import { Response } from 'express';
import Logger from '../../../lib/logger';

interface SSEClient {
  id: string;
  userId: string;
  response: Response;
  connectedAt: Date;
}

/**
 * Server-Sent Events (SSE) Manager
 * Manages SSE connections for real-time context processing updates
 */
class SSEManager {
  private clients: Map<string, SSEClient[]> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Start heartbeat to keep connections alive
    this.startHeartbeat();
  }

  /**
   * Add a new SSE client connection
   */
  addClient(userId: string, clientId: string, res: Response): void {
    const client: SSEClient = {
      id: clientId,
      userId,
      response: res,
      connectedAt: new Date(),
    };

    // Get existing clients for this user or create new array
    const userClients = this.clients.get(userId) || [];
    userClients.push(client);
    this.clients.set(userId, userClients);

    Logger.info(`SSE client connected: userId=${userId}, clientId=${clientId}`);

    // Setup response headers for SSE

    // prettier-ignore
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send initial connection confirmation
    this.sendEvent(res, 'connected', { clientId, timestamp: new Date().toISOString() });

    // Handle client disconnect
    res.on('close', () => {
      this.removeClient(userId, clientId);
    });
  }

  /**
   * Remove a client connection
   */
  removeClient(userId: string, clientId: string): void {
    const userClients = this.clients.get(userId);
    if (!userClients) return;

    const updatedClients = userClients.filter((client) => client.id !== clientId);

    if (updatedClients.length === 0) {
      this.clients.delete(userId);
    } else {
      this.clients.set(userId, updatedClients);
    }

    Logger.info(`SSE client disconnected: userId=${userId}, clientId=${clientId}`);
  }

  /**
   * Send context status update to all connected clients for a user
   */
  sendContextUpdate(
    userId: string,
    data: {
      contextId: string;
      status: 'completed' | 'inprogress' | 'error';
      errorMessage?: string;
      vectorIds?: string[];
      processingProgress?: number;
      title?: string;
      description?: string;
    },
  ): void {
    const userClients = this.clients.get(userId);

    if (!userClients || userClients.length === 0) {
      Logger.debug(`No SSE clients connected for userId=${userId}`);
      return;
    }

    Logger.info(
      `Sending SSE context update to ${userClients.length} client(s) for userId=${userId}, contextId=${data.contextId}, progress=${data.processingProgress}%`,
    );

    userClients.forEach((client) => {
      try {
        this.sendEvent(client.response, 'context-update', data);
      } catch (error) {
        Logger.error(`Failed to send SSE event to client ${client.id}:`, error);
        this.removeClient(userId, client.id);
      }
    });
  }

  /**
   * Send an SSE event to a specific response
   */
  private sendEvent(res: Response, event: string, data: any): void {
    const eventData = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    res.write(eventData);
  }

  /**
   * Send heartbeat to all connected clients to keep connections alive
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.clients.forEach((userClients, userId) => {
        userClients.forEach((client) => {
          try {
            this.sendEvent(client.response, 'heartbeat', { timestamp: new Date().toISOString() });
          } catch (error) {
            Logger.error(`Heartbeat failed for client ${client.id}:`, error);
            this.removeClient(userId, client.id);
          }
        });
      });
    }, 30000); // Send heartbeat every 30 seconds
  }

  /**
   * Get count of active connections
   */
  getActiveConnectionsCount(): number {
    let count = 0;
    this.clients.forEach((userClients) => {
      count += userClients.length;
    });
    return count;
  }

  /**
   * Get active connections for a specific user
   */
  getUserConnectionsCount(userId: string): number {
    return this.clients.get(userId)?.length || 0;
  }

  /**
   * Cleanup - stop heartbeat and close all connections
   */
  cleanup(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    this.clients.forEach((userClients) => {
      userClients.forEach((client) => {
        try {
          client.response.end();
        } catch (error) {
          Logger.error(`Error closing SSE connection:`, error);
        }
      });
    });

    this.clients.clear();
    Logger.info('SSE Manager cleaned up');
  }
}

// Singleton instance
export const sseManager = new SSEManager();
