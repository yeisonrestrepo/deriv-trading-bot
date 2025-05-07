const WebSocket = require('ws');
require('dotenv').config();

// Load API credentials from environment variables
const API_URL = 'wss://ws.derivws.com/websockets/v3';
const APP_ID = process.env.APP_ID || '74555';
const API_TOKEN = process.env.API_TOKEN || 'ZBsf8h8dXBU4h31';

class DerivAPI {
    constructor() {
        this.socket = null;
        this.connected = false;
        this.authorized = false;
        this.messageHandlers = new Map();
        this.reqId = 1;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectTimeout = null;
    }

    // Connect to the Deriv WebSocket API
    connect() {
        return new Promise((resolve, reject) => {
            try {
                this.socket = new WebSocket(`${API_URL}?app_id=${APP_ID}`);
                
                this.socket.onopen = () => {
                    console.log('\x1b[36mConnection established with Deriv API\x1b[0m');
                    this.connected = true;
                    this.reconnectAttempts = 0;
                    resolve();
                };
                
                this.socket.onclose = (event) => {
                    console.log(`\x1b[33mConnection closed: ${event.reason || 'Unknown reason'}\x1b[0m`);
                    this.connected = false;
                    this.authorized = false;
                    
                    // Attempt to reconnect if not a deliberate disconnect
                    if (!event.wasClean && this.reconnectAttempts < this.maxReconnectAttempts) {
                        this.scheduleReconnect();
                    }
                };
                
                this.socket.onerror = (error) => {
                    console.error('\x1b[31mWebSocket error:\x1b[0m', error);
                    if (!this.connected) {
                        reject(new Error('Failed to connect to Deriv API'));
                    }
                };
                
                this.socket.onmessage = (message) => {
                    try {
                        const data = JSON.parse(message.data);
                        
                        // Check for errors
                        if (data.error) {
                            console.error('\x1b[31mAPI Error:\x1b[0m', data.error.message);
                            
                            // For handlers waiting for this specific response
                            const handler = this.messageHandlers.get(data.req_id);
                            if (handler) {
                                handler.reject(data.error);
                                this.messageHandlers.delete(data.req_id);
                            }
                            return;
                        }
                        
                        // Handle authorization response
                        if (data.msg_type === 'authorize') {
                            this.authorized = true;
                            console.log('\x1b[36mSuccessfully authorized with Deriv API\x1b[0m');
                            console.log(`\x1b[36mAccount ID:\x1b[0m ${data.authorize.loginid}`);
                            console.log(`\x1b[36mBalance:\x1b[0m ${data.authorize.balance} ${data.authorize.currency}`);
                        }
                        
                        // Call the handler associated with this request ID
                        const handler = this.messageHandlers.get(data.req_id);
                        if (handler) {
                            handler.resolve(data);
                            this.messageHandlers.delete(data.req_id);
                        }
                    } catch (error) {
                        console.error('\x1b[31mError processing WebSocket message:\x1b[0m', error);
                    }
                };
            } catch (error) {
                console.error('\x1b[31mError creating WebSocket connection:\x1b[0m', error);
                reject(error);
            }
        });
    }
    
    scheduleReconnect() {
        this.reconnectAttempts++;
        const delay = Math.min(30000, Math.pow(2, this.reconnectAttempts) * 1000); // Exponential backoff
        
        console.log(`\x1b[33mAttempting to reconnect in ${delay/1000} seconds (Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...\x1b[0m`);
        
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = setTimeout(async () => {
            try {
                await this.connect();
                if (this.connected) {
                    await this.authorize();
                }
            } catch (error) {
                console.error('\x1b[31mReconnection failed:\x1b[0m', error.message);
            }
        }, delay);
    }
    
    // Authenticate with the API token
    authorize() {
        if (!this.connected) {
            return Promise.reject(new Error('Not connected to Deriv API'));
        }
        
        return this.send({
            authorize: API_TOKEN
        });
    }
    
    // Send a WebSocket message and return a promise for the response
    send(request) {
        if (!this.connected) {
            return Promise.reject(new Error('Not connected to Deriv API'));
        }
        
        const req_id = this.reqId++;
        request.req_id = req_id;
        
        return new Promise((resolve, reject) => {
            try {
                this.messageHandlers.set(req_id, { resolve, reject });
                this.socket.send(JSON.stringify(request));
                
                // Set a timeout for the request
                setTimeout(() => {
                    if (this.messageHandlers.has(req_id)) {
                        this.messageHandlers.delete(req_id);
                        reject(new Error(`Request ${req_id} timed out after 30 seconds`));
                    }
                }, 30000);
            } catch (error) {
                this.messageHandlers.delete(req_id);
                reject(error);
            }
        });
    }
    
    // Disconnect from the API
    disconnect() {
        clearTimeout(this.reconnectTimeout);
        
        if (this.socket && this.connected) {
            this.socket.close();
            console.log('\x1b[36mDisconnected from Deriv API\x1b[0m');
        }
    }
    
    // Check connection status
    isConnected() {
        return this.connected;
    }
    
    // Check if authenticated
    isAuthorized() {
        return this.authorized;
    }
}

module.exports = {
    DerivAPI
};