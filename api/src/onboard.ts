/**
 * Onboarding routes — serves the QR code page and handles WebSocket
 * for live QR code updates during WhatsApp linking.
 */

import type { Express } from 'express';
import type { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

import { getClientByToken, updateClientStatus } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Track active WebSocket connections by client ID
const activeConnections = new Map<string, Set<WebSocket>>();

export function setupOnboardRoutes(app: Express, server: Server): void {
  // Serve onboarding page
  app.get('/onboard/:token', (req, res) => {
    const client = getClientByToken(req.params.token);

    if (!client) {
      res.status(404).send(`
        <html><body style="font-family:system-ui;text-align:center;padding:40px;background:#0a0a0a;color:#fff">
          <h1>Lien expiré ou invalide</h1>
          <p>Contacte matthieu@hntic.fr pour un nouveau lien.</p>
        </body></html>
      `);
      return;
    }

    if (client.status === 'active') {
      res.send(`
        <html><body style="font-family:system-ui;text-align:center;padding:40px;background:#0a0a0a;color:#fff">
          <h1 style="color:#22c55e">WhatsApp déjà connecté</h1>
          <p>Otto est actif. Tu peux fermer cette page et ouvrir WhatsApp.</p>
        </body></html>
      `);
      return;
    }

    res.sendFile(path.join(__dirname, '..', 'public', 'onboard.html'));
  });

  // WebSocket server for live QR code updates
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = req.url || '';
    const match = url.match(/^\/ws\/(.+)$/);
    if (!match) {
      socket.destroy();
      return;
    }

    const token = match[1];
    const client = getClientByToken(token);
    if (!client) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      // Track connection
      let connections = activeConnections.get(client.id);
      if (!connections) {
        connections = new Set();
        activeConnections.set(client.id, connections);
      }
      connections.add(ws);

      ws.on('close', () => {
        connections?.delete(ws);
        if (connections?.size === 0) {
          activeConnections.delete(client.id);
        }
      });

      // Send initial status
      ws.send(JSON.stringify({ type: 'status', status: client.status }));
    });
  });
}

/**
 * Broadcast a QR code to all connected WebSocket clients for a given client ID.
 * Called by the NanoClaw process via PM2 IPC bus (production) or direct call (dev).
 */
export function broadcastQrCode(clientId: string, qrData: string): void {
  const connections = activeConnections.get(clientId);
  if (!connections) return;

  const message = JSON.stringify({ type: 'qr', data: qrData });
  for (const ws of connections) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

/**
 * Notify all connected WebSocket clients that WhatsApp is connected.
 */
export function broadcastConnected(clientId: string): void {
  updateClientStatus(clientId, 'active');

  const connections = activeConnections.get(clientId);
  if (!connections) return;

  const message = JSON.stringify({ type: 'connected' });
  for (const ws of connections) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}
