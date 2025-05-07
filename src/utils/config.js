/**
 * Configuration loader and validator for the Deriv Trading Bot
 */

require('dotenv').config();
const logger = require('./logger');

/**
 * Default configuration values
 */
const DEFAULT_CONFIG = {
    // API Connection
    API_URL: 'wss://ws.derivws.com/websockets/v3',
    APP_ID: null,
    API_TOKEN: null,
    
    // Trading parameters
    DEFAULT_SYMBOL: 'R_100',
    MAX_CONSECUTIVE_DIGITS: 3,
    CURRENCY: 'USD',
    CONTRACT_DURATION: 1,
    CONTRACT_DURATION_UNIT: 't', // tick
    
    // Martingale strategy
    MARTINGALE_MULTIPLIERS: [0.35, 0.69, 1.39, 2.84, 5.8, 11.52, 23.51, 47.98],
    
    // Allowed symbols
    ALLOWED_SYMBOLS: [
        '1HZ10V', 'R_10', 
        '1HZ25V', 'R_25', 
        '1HZ50V', 'R_50', 
        '1HZ75V', 'R_75', 
        '1HZ100V', 'R_100', 
        'RDBEAR', 'RDBULL'
    ],
    
    // Connection settings
    RECONNECT_INTERVAL: 5000,  // 5 seconds
    MAX_RECONNECT_ATTEMPTS: 5,
    MESSAGE_TIMEOUT: 30000,    // 30 seconds
    
    // Logger settings
    LOG_LEVEL: 'INFO',         // DEBUG, INFO, TRADE, SUCCESS, WARNING, ERROR, CRITICAL
    LOG_TO_FILE: false,
    LOG_FILE_PATH: './logs/deriv-bot.log',
    
    // Trading limits for safety
    MAX_DAILY_LOSS: null,      // Set to a value to limit daily losses
    MAX_CONSECUTIVE_LOSSES: null, // Set to limit consecutive losses
    TRADING_ENABLED: true,     // Can be set to false to run in simulation mode
};

/**
 * Config validation rules
 */
const CONFIG_VALIDATION = {
    APP_ID: {
        required: true,
        type: 'number',
        validate: (value) => value > 0,
        message: 'APP_ID must be a positive number'
    },
    API_TOKEN: {
        required: true,
        type: 'string',
        validate: (value) => value.length > 0,
        message: 'API_TOKEN is required'
    },
    DEFAULT_SYMBOL: {
        required: false,
        type: 'string',
        validate: (value, config) => config.ALLOWED_SYMBOLS.includes(value),
        message: (value) => `Symbol ${value} is not in the list of allowed symbols`
    }
};

class Config {
    constructor() {
        this.config = { ...DEFAULT_CONFIG };
        this.loadFromEnv();
        this.parseCommandLineArgs();
        this.validate();
    }

    /**
     * Load configuration from environment variables
     */
    loadFromEnv() {
        // Iterate through all config keys and check for environment variables
        Object.keys(this.config).forEach(key => {
            if (process.env[key] !== undefined) {
                // Convert string values to appropriate types
                let value = process.env[key];
                
                // Handle arrays
                if (Array.isArray(this.config[key])) {
                    try {
                        value = JSON.parse(value);
                    } catch (e) {
                        // If not valid JSON, try comma-separated values
                        value = value.split(',').map(item => {
                            // Try to convert to number if possible
                            const num = Number(item.trim());
                            return isNaN(num) ? item.trim() : num;
                        });
                    }
                }
                // Handle booleans
                else if (typeof this.config[key] === 'boolean') {
                    value = value.toLowerCase() === 'true';
                }
                // Handle numbers
                else if (typeof this.config[key] === 'number') {
                    value = Number(value);
                }
                
                this.config[key] = value;
            }
        });
    }

    /**
     * Parse command line arguments
     */
    parseCommandLineArgs() {
        const args = process.argv.slice(2);
        
        // Check for symbol argument
        if (args[0] && !args[0].startsWith('-')) {
            const symbol = args[0].toUpperCase();
            if (this.config.ALLOWED_SYMBOLS.includes(symbol)) {
                this.config.DEFAULT_SYMBOL = symbol;
            } else {
                logger.warning(`Symbol ${symbol} not in allowed list, using default ${this.config.DEFAULT_SYMBOL}`);
            }
        }
        
        // Check for max consecutive digits argument
        if (args[1] && !args[1].startsWith('-')) {
            const maxDigits = parseInt(args[1]);
            if (!isNaN(maxDigits) && maxDigits > 0) {
                this.config.MAX_CONSECUTIVE_DIGITS = maxDigits;
            } else {
                logger.warning(`Invalid MAX_CONSECUTIVE_DIGITS value: ${args[1]}, using default ${this.config.MAX_CONSECUTIVE_DIGITS}`);
            }
        }
        
        // Handle flag arguments (e.g., --debug, --simulation)
        args.forEach(arg => {
            if (arg === '--debug') {
                this.config.LOG_LEVEL = 'DEBUG';
            } else if (arg === '--simulation') {
                this.config.TRADING_ENABLED = false;
            }
        });
    }

    /**
     * Validate the configuration
     */
    validate() {
        const errors = [];
        
        // Check required fields and validation rules
        Object.keys(CONFIG_VALIDATION).forEach(key => {
            const rule = CONFIG_VALIDATION[key];
            const value = this.config[key];
            
            // Check if required
            if (rule.required && (value === null || value === undefined)) {
                errors.push(`${key} is required but not provided`);
                return;
            }
            
            // Skip further validation if value is not provided
            if (value === null || value === undefined) return;
            
            // Check type
            if (rule.type && typeof value !== rule.type && 
                !(rule.type === 'number' && !isNaN(Number(value)))) {
                errors.push(`${key} must be of type ${rule.type}`);
                return;
            }
            
            // Run custom validation
            if (rule.validate && !rule.validate(value, this.config)) {
                const message = typeof rule.message === 'function' 
                    ? rule.message(value) 
                    : rule.message;
                errors.push(message);
            }
        });
        
        // Report validation errors
        if (errors.length > 0) {
            logger.critical('Configuration validation failed:');
            errors.forEach(error => logger.error('- ' + error));
            logger.info('Please check your .env file and command line arguments');
            process.exit(1);
        }
    }

    /**
     * Get the complete configuration object
     */
    getConfig() {
        return { ...this.config };
    }

    /**
     * Get a specific configuration value
     */
    get(key) {
        return this.config[key];
    }

    /**
     * Update a configuration value at runtime
     */
    set(key, value) {
        // Only allow updating existing keys
        if (this.config.hasOwnProperty(key)) {
            this.config[key] = value;
            
            // Validate the new value if we have a rule for it
            if (CONFIG_VALIDATION[key] && CONFIG_VALIDATION[key].validate) {
                const isValid = CONFIG_VALIDATION[key].validate(value, this.config);
                if (!isValid) {
                    const message = typeof CONFIG_VALIDATION[key].message === 'function'
                        ? CONFIG_VALIDATION[key].message(value)
                        : CONFIG_VALIDATION[key].message;
                    logger.warning(`Invalid config update: ${message}`);
                    return false;
                }
            }
            
            return true;
        }
        return false;
    }

    /**
     * Display the current configuration (with sensitive data masked)
     */
    displayConfig() {
        logger.info('Current configuration:');
        
        const sensitiveKeys = ['API_TOKEN', 'APP_ID'];
        const configCopy = { ...this.config };
        
        // Mask sensitive values
        sensitiveKeys.forEach(key => {
            if (configCopy[key]) {
                configCopy[key] = '********';
            }
        });
        
        // Group related settings
        const groups = {
            'API Settings': ['API_URL', 'APP_ID', 'API_TOKEN'],
            'Trading Parameters': [
                'DEFAULT_SYMBOL', 'MAX_CONSECUTIVE_DIGITS', 'CURRENCY',
                'CONTRACT_DURATION', 'CONTRACT_DURATION_UNIT', 'TRADING_ENABLED'
            ],
            'Martingale Strategy': ['MARTINGALE_MULTIPLIERS'],
            'Allowed Symbols': ['ALLOWED_SYMBOLS'],
            'Connection Settings': [
                'RECONNECT_INTERVAL', 'MAX_RECONNECT_ATTEMPTS', 'MESSAGE_TIMEOUT'
            ],
            'Logging': ['LOG_LEVEL', 'LOG_TO_FILE', 'LOG_FILE_PATH'],
            'Safety Limits': ['MAX_DAILY_LOSS', 'MAX_CONSECUTIVE_LOSSES']
        };
        
        // Display by groups
        Object.entries(groups).forEach(([groupName, keys]) => {
            logger.info(`\n${groupName}:`);
            keys.forEach(key => {
                const value = configCopy[key];
                const valueStr = Array.isArray(value) 
                    ? `[${value.join(', ')}]` 
                    : (value === null ? 'null' : value);
                console.log(`  ${key}: ${valueStr}`);
            });
        });
    }
}

// Create and export a singleton instance
const config = new Config();
module.exports = config;