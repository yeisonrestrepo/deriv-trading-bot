/**
 * DerivAPI - WebSocket API wrapper for Deriv.com
 * 
 * Handles secure WebSocket connections, authentication, and message handling
 * with the Deriv API.
 */

const WebSocket = require('ws');
const config = require('./utils/config');
const logger = require('./utils/logger');

class DerivAPI {
    constructor() {
        this.socket = null;
        this.connected = false;
        this.authorized = false;
        this.messageHandlers = new Map();
        this.reqId = 1;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = config.get('MAX_RECONNECT_ATTEMPTS');
        this.reconnectTimeout = null;
    }

    // Connect to the Deriv WebSocket API
    connect(callBackOnReconnect) {
        return new Promise((resolve, reject) => {
            try {
                const apiUrl = config.get('API_URL');
                const appId = config.get('APP_ID');
                
                this.socket = new WebSocket(`${apiUrl}?app_id=${appId}`);
                
                this.socket.onopen = () => {
                    logger.success('Connection established with Deriv API');
                    this.connected = true;
                    this.reconnectAttempts = 0;
                    resolve();
                };
                
                this.socket.onclose = (event) => {
                    logger.warning(`Connection closed: ${event.reason || 'Unknown reason'}`);
                    this.connected = false;
                    this.authorized = false;
                    
                    // Attempt to reconnect if not a deliberate disconnect
                    if (!event.wasClean && this.reconnectAttempts < this.maxReconnectAttempts) {
                        this.scheduleReconnect(callBackOnReconnect);
                    }
                };
                
                this.socket.onerror = (error) => {
                    logger.error('WebSocket error:', error);
                    if (!this.connected) {
                        reject(new Error('Failed to connect to Deriv API'));
                    }
                };
                
                this.socket.onmessage = (message) => {
                    try {
                        const data = JSON.parse(message.data);
                        
                        // Log detailed API responses in debug mode
                        if (config.get('LOG_LEVEL') === 'DEBUG') {
                            logger.debug(`API Response (${data.msg_type}):`);
                            if (data.msg_type !== 'tick') { // Don't log every tick in detail
                                logger.logObject('DEBUG', 'Data', data);
                            }
                        }
                        
                        // Check for errors
                        if (data.error) {
                            logger.error('API Error:', data.error.message);
                            
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
                            logger.success('Successfully authorized with Deriv API');
                            logger.info(`Account ID: ${data.authorize.loginid}`);
                            logger.info(`Balance: ${data.authorize.balance} ${data.authorize.currency}`);
                        }
                        
                        // Call the handler associated with this request ID
                        const handler = this.messageHandlers.get(data.req_id);
                        if (handler) {
                            handler.resolve(data);
                            this.messageHandlers.delete(data.req_id);
                        }
                    } catch (error) {
                        logger.error('Error processing WebSocket message:', error);
                    }
                };
            } catch (error) {
                logger.error('Error creating WebSocket connection:', error);
                reject(error);
            }
        });
    }
    
    scheduleReconnect(callBackOnReconnect) {
        this.reconnectAttempts++;
        const delay = Math.min(30000, Math.pow(2, this.reconnectAttempts) * 1000); // Exponential backoff
        
        logger.warning(`Attempting to reconnect in ${delay/1000} seconds (Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
        
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = setTimeout(async () => {
            try {
                await this.connect();
                if (this.connected) {
                    await this.authorize();
                    callBackOnReconnect();
                }
            } catch (error) {
                logger.error('Reconnection failed:', error.message);
            }
        }, delay);
    }
    
    // Authenticate with the API token
    authorize() {
        if (!this.connected) {
            return Promise.reject(new Error('Not connected to Deriv API'));
        }
        
        const apiToken = config.get('API_TOKEN');
        
        return this.send({
            authorize: apiToken
        });
    }
    
    // Send a WebSocket message and return a promise for the response
    send(request) {
        if (!this.connected) {
            return Promise.reject(new Error('Not connected to Deriv API'));
        }
        
        const req_id = this.reqId++;
        request.req_id = req_id;
        
        if (config.get('LOG_LEVEL') === 'DEBUG') {
            // For sensitive requests, mask the token in logs
            const logRequest = { ...request };
            if (logRequest.authorize) {
                logRequest.authorize = '********';
            }
            logger.debug(`API Request: ${JSON.stringify(logRequest)}`);
        }
        
        return new Promise((resolve, reject) => {
            try {
                this.messageHandlers.set(req_id, { resolve, reject });
                this.socket.send(JSON.stringify(request));
                
                // Set a timeout for the request
                setTimeout(() => {
                    if (this.messageHandlers.has(req_id)) {
                        this.messageHandlers.delete(req_id);
                        reject(new Error(`Request ${req_id} timed out after ${config.get('MESSAGE_TIMEOUT')/1000} seconds`));
                    }
                }, config.get('MESSAGE_TIMEOUT'));
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
            logger.info('Disconnected from Deriv API');
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