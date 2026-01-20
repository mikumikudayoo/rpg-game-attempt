// ==========================================
// WEBSOCKET MANAGER FOR COMBAT SESSIONS
// ==========================================

import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { Server } from 'http';

// Message types for WebSocket communication
export interface WSMessage {
    type: string;
    payload?: any;
    sessionId?: string;
    timestamp?: number;
}

// Client connection info
interface ClientConnection {
    ws: WebSocket;
    sessionId: string;
    username: string;
    connectedAt: Date;
    lastPing: Date;
}

// WebSocket Manager class
export class CombatWebSocketManager {
    private wss: WebSocketServer;
    private connections: Map<string, ClientConnection> = new Map(); // sessionId -> connection
    private userSessions: Map<string, string> = new Map(); // username -> sessionId
    private heartbeatInterval: NodeJS.Timer | null = null;
    
    // Callbacks for handling messages (set by index.ts)
    public onPlayerAction: ((sessionId: string, action: any) => Promise<void>) | null = null;
    public onPlayerReconnect: ((sessionId: string, username: string) => Promise<any>) | null = null;
    public onPlayerDisconnect: ((sessionId: string, username: string) => Promise<void>) | null = null;
    
    constructor(server: Server) {
        this.wss = new WebSocketServer({ 
            server,
            path: '/ws/combat'
        });
        
        this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
            this.handleConnection(ws, req);
        });
        
        // Start heartbeat to detect dead connections
        this.startHeartbeat();
        
        console.log('Combat WebSocket server initialized on /ws/combat');
    }
    
    private handleConnection(ws: WebSocket, req: IncomingMessage) {
        console.log('New WebSocket connection attempt');
        
        // Parse session info from URL query params
        const url = new URL(req.url || '', `http://${req.headers.host}`);
        const sessionId = url.searchParams.get('sessionId');
        const username = url.searchParams.get('username');
        
        if (!sessionId || !username) {
            console.log('WebSocket connection rejected: missing sessionId or username');
            ws.close(4001, 'Missing sessionId or username');
            return;
        }
        
        // Check if there's an existing connection for this session
        const existingConnection = this.connections.get(sessionId);
        if (existingConnection) {
            // Close old connection
            console.log(`Closing existing connection for session ${sessionId}`);
            existingConnection.ws.close(4002, 'New connection established');
            this.connections.delete(sessionId);
        }
        
        // Store connection
        const connection: ClientConnection = {
            ws,
            sessionId,
            username,
            connectedAt: new Date(),
            lastPing: new Date()
        };
        this.connections.set(sessionId, connection);
        this.userSessions.set(username, sessionId);
        
        console.log(`WebSocket connected: session=${sessionId}, user=${username}`);
        
        // Send connection confirmation
        this.sendToSession(sessionId, {
            type: 'connected',
            payload: { sessionId, username, message: 'WebSocket connection established' }
        });
        
        // Handle reconnection - send current state
        if (this.onPlayerReconnect) {
            this.onPlayerReconnect(sessionId, username).then(state => {
                if (state) {
                    this.sendToSession(sessionId, {
                        type: 'session_restored',
                        payload: state
                    });
                }
            }).catch(err => {
                console.error('Error on reconnect:', err);
            });
        }
        
        // Handle incoming messages
        ws.on('message', (data: Buffer) => {
            try {
                const message: WSMessage = JSON.parse(data.toString());
                this.handleMessage(sessionId, username, message);
            } catch (e) {
                console.error('Failed to parse WebSocket message:', e);
                this.sendToSession(sessionId, {
                    type: 'error',
                    payload: { error: 'Invalid message format' }
                });
            }
        });
        
        // Handle pong (heartbeat response)
        ws.on('pong', () => {
            const conn = this.connections.get(sessionId);
            if (conn) {
                conn.lastPing = new Date();
            }
        });
        
        // Handle close
        ws.on('close', (code: number, reason: Buffer) => {
            console.log(`WebSocket closed: session=${sessionId}, code=${code}, reason=${reason.toString()}`);
            this.connections.delete(sessionId);
            this.userSessions.delete(username);
            
            // Notify about disconnect (session persists in DB)
            if (this.onPlayerDisconnect) {
                this.onPlayerDisconnect(sessionId, username).catch(err => {
                    console.error('Error on disconnect:', err);
                });
            }
        });
        
        // Handle errors
        ws.on('error', (error: Error) => {
            console.error(`WebSocket error for session ${sessionId}:`, error);
        });
    }
    
    private handleMessage(sessionId: string, username: string, message: WSMessage) {
        console.log(`WS message from ${username} (${sessionId}):`, message.type);
        
        switch (message.type) {
            case 'ping':
                this.sendToSession(sessionId, { type: 'pong', timestamp: Date.now() });
                break;
                
            case 'player_action':
                // Player assigned a target or performed an action
                if (this.onPlayerAction && message.payload) {
                    this.onPlayerAction(sessionId, message.payload).catch(err => {
                        console.error('Error handling player action:', err);
                        this.sendToSession(sessionId, {
                            type: 'error',
                            payload: { error: 'Failed to process action' }
                        });
                    });
                }
                break;
                
            case 'execute_turn':
                // Player confirmed their actions and wants to execute the turn
                if (this.onPlayerAction && message.payload) {
                    this.onPlayerAction(sessionId, {
                        type: 'execute_turn',
                        actions: message.payload.actions
                    }).catch(err => {
                        console.error('Error executing turn:', err);
                        this.sendToSession(sessionId, {
                            type: 'error',
                            payload: { error: 'Failed to execute turn' }
                        });
                    });
                }
                break;
                
            case 'get_state':
                // Client requesting current session state
                if (this.onPlayerReconnect) {
                    this.onPlayerReconnect(sessionId, username).then(state => {
                        if (state) {
                            this.sendToSession(sessionId, {
                                type: 'state_update',
                                payload: state
                            });
                        }
                    });
                }
                break;
                
            case 'end_combat':
                // Player wants to end the combat session
                if (this.onPlayerAction) {
                    this.onPlayerAction(sessionId, { type: 'end_combat' }).catch(err => {
                        console.error('Error ending combat:', err);
                    });
                }
                break;
                
            default:
                console.log(`Unknown message type: ${message.type}`);
        }
    }
    
    // Send message to a specific session
    public sendToSession(sessionId: string, message: WSMessage): boolean {
        const connection = this.connections.get(sessionId);
        if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
            return false;
        }
        
        try {
            connection.ws.send(JSON.stringify({
                ...message,
                timestamp: Date.now()
            }));
            return true;
        } catch (e) {
            console.error(`Failed to send message to session ${sessionId}:`, e);
            return false;
        }
    }
    
    // Send message to a user by username
    public sendToUser(username: string, message: WSMessage): boolean {
        const sessionId = this.userSessions.get(username);
        if (!sessionId) return false;
        return this.sendToSession(sessionId, message);
    }
    
    // Check if a session has an active connection
    public isSessionConnected(sessionId: string): boolean {
        const connection = this.connections.get(sessionId);
        return connection !== undefined && connection.ws.readyState === WebSocket.OPEN;
    }
    
    // Get connection info for a session
    public getConnectionInfo(sessionId: string): { username: string; connectedAt: Date } | null {
        const connection = this.connections.get(sessionId);
        if (!connection) return null;
        return {
            username: connection.username,
            connectedAt: connection.connectedAt
        };
    }
    
    // Start heartbeat interval to detect dead connections
    private startHeartbeat() {
        this.heartbeatInterval = setInterval(() => {
            const now = new Date();
            this.connections.forEach((conn, sessionId) => {
                // If no pong received in 30 seconds, consider connection dead
                if (now.getTime() - conn.lastPing.getTime() > 30000) {
                    console.log(`Heartbeat timeout for session ${sessionId}`);
                    conn.ws.terminate();
                    this.connections.delete(sessionId);
                    this.userSessions.delete(conn.username);
                    return;
                }
                
                // Send ping
                if (conn.ws.readyState === WebSocket.OPEN) {
                    conn.ws.ping();
                }
            });
        }, 10000); // Check every 10 seconds
    }
    
    // Cleanup
    public close() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }
        
        this.connections.forEach((conn, sessionId) => {
            conn.ws.close(1001, 'Server shutting down');
        });
        
        this.wss.close();
    }
}
