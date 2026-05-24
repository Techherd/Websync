import { FastifyInstance } from 'fastify';
import { WebSocket, RawData } from 'ws';

// Store all connected clients
const clients: Set<WebSocket> = new Set();

export interface JobUpdate {
    type: 'job:started' | 'job:progress' | 'job:completed' | 'job:failed';
    job?: any;
    jobId?: string;
    progress?: number;
    message?: string;
    error?: string;
}

export const broadcastJobUpdate = (update: JobUpdate) => {
    broadcast(update);
};

export const broadcast = (payload: unknown) => {
    const message = JSON.stringify(payload);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
};

export const registerWebSocket = async (server: FastifyInstance) => {
    server.get('/ws', { websocket: true }, (socket, request) => {
        console.log('WebSocket client connected');
        clients.add(socket);

        socket.on('message', (message: RawData) => {
            try {
                const data = JSON.parse(message.toString());
                // Handle ping/pong for keep-alive
                if (data.type === 'ping') {
                    socket.send(JSON.stringify({ type: 'pong' }));
                }
            } catch (e) {
                // Ignore invalid messages
            }
        });

        socket.on('close', () => {
            console.log('WebSocket client disconnected');
            clients.delete(socket);
        });

        socket.on('error', (err: Error) => {
            console.error('WebSocket error:', err);
            clients.delete(socket);
        });

        // Send initial connection confirmation
        socket.send(JSON.stringify({ type: 'connected' }));
    });
};

export const getConnectedClientsCount = () => clients.size;
