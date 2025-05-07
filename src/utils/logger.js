/**
 * Logger utility for the Deriv Trading Bot
 * Provides consistent logging with timestamps, colors, and log levels
 */

// ANSI color codes for terminal output
const COLORS = {
    RESET: '\x1b[0m',
    RED: '\x1b[31m',
    GREEN: '\x1b[32m',
    YELLOW: '\x1b[33m',
    BLUE: '\x1b[34m',
    MAGENTA: '\x1b[35m',
    CYAN: '\x1b[36m',
    GRAY: '\x1b[90m',
    BOLD: '\x1b[1m',
    UNDERLINE: '\x1b[4m'
};

// Log levels with corresponding methods and colors
const LOG_LEVELS = {
    DEBUG: { value: 0, color: COLORS.GRAY, prefix: 'DEBUG' },
    INFO: { value: 1, color: COLORS.CYAN, prefix: 'INFO' },
    TRADE: { value: 2, color: COLORS.BLUE, prefix: 'TRADE' },
    SUCCESS: { value: 3, color: COLORS.GREEN, prefix: 'SUCCESS' },
    WARNING: { value: 4, color: COLORS.YELLOW, prefix: 'WARNING' },
    ERROR: { value: 5, color: COLORS.RED, prefix: 'ERROR' },
    CRITICAL: { value: 6, color: COLORS.RED + COLORS.BOLD, prefix: 'CRITICAL' }
};

class Logger {
    constructor(options = {}) {
        // Default options
        this.options = {
            level: process.env.LOG_LEVEL || 'INFO',
            enableColors: true,
            timestamp: true,
            logToFile: false,
            logFilePath: './logs/bot.log',
            ...options
        };

        // Convert level string to value
        this.currentLevel = LOG_LEVELS[this.options.level.toUpperCase()] 
            ? LOG_LEVELS[this.options.level.toUpperCase()].value 
            : LOG_LEVELS.INFO.value;
        
        // Set up file logging if enabled
        if (this.options.logToFile) {
            this.setupFileLogging();
        }
    }

    setupFileLogging() {
        const fs = require('fs');
        const path = require('path');
        
        // Create logs directory if it doesn't exist
        const logDir = path.dirname(this.options.logFilePath);
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        
        this.logStream = fs.createWriteStream(this.options.logFilePath, { flags: 'a' });
        
        // Handle process exit to close file stream
        process.on('exit', () => {
            if (this.logStream) {
                this.logStream.end();
            }
        });
    }

    // Format the log message with timestamp, level prefix and colors
    formatMessage(level, message) {
        const timestamp = this.options.timestamp ? `[${new Date().toISOString()}] ` : '';
        const prefix = `[${level.prefix}]`;
        
        // Plain message for file logging
        const plainMessage = `${timestamp}${prefix} ${message}`;
        
        // Colored message for console
        const coloredPrefix = this.options.enableColors 
            ? `${level.color}${prefix}${COLORS.RESET}` 
            : prefix;
        
        const coloredMessage = `${timestamp}${coloredPrefix} ${message}`;
        
        return { plainMessage, coloredMessage };
    }

    // Log a message if its level is >= the current level threshold
    log(level, message, ...args) {
        if (level.value < this.currentLevel) {
            return;
        }

        const { plainMessage, coloredMessage } = this.formatMessage(level, message);
        
        // Log to console
        console.log(coloredMessage, ...args);
        
        // Log to file if enabled (without colors)
        if (this.options.logToFile && this.logStream) {
            // If args contain objects, stringify them
            const formattedArgs = args.map(arg => 
                typeof arg === 'object' ? JSON.stringify(arg) : arg
            ).join(' ');
            
            this.logStream.write(plainMessage + (formattedArgs ? ' ' + formattedArgs : '') + '\n');
        }
    }

    // Create methods for each log level
    debug(message, ...args) {
        this.log(LOG_LEVELS.DEBUG, message, ...args);
    }

    info(message, ...args) {
        this.log(LOG_LEVELS.INFO, message, ...args);
    }

    trade(message, ...args) {
        this.log(LOG_LEVELS.TRADE, message, ...args);
    }

    success(message, ...args) {
        this.log(LOG_LEVELS.SUCCESS, message, ...args);
    }

    warning(message, ...args) {
        this.log(LOG_LEVELS.WARNING, message, ...args);
    }

    error(message, ...args) {
        this.log(LOG_LEVELS.ERROR, message, ...args);
    }

    critical(message, ...args) {
        this.log(LOG_LEVELS.CRITICAL, message, ...args);
    }

    // Special logging for trade activities
    tradeStart(contractType, stake, symbol) {
        this.trade(`Placing ${COLORS.YELLOW}${contractType}${COLORS.RESET} trade on ${symbol} with stake ${COLORS.YELLOW}${stake}${COLORS.RESET}`);
    }

    tradeWin(contractType, profit, balance) {
        this.success(`Trade ${COLORS.GREEN}WON${COLORS.RESET}: ${contractType} +${profit} (Balance: ${balance})`);
    }

    tradeLoss(contractType, loss, balance) {
        this.warning(`Trade ${COLORS.RED}LOST${COLORS.RESET}: ${contractType} -${Math.abs(loss)} (Balance: ${balance})`);
    }

    // Log an object as formatted JSON
    logObject(level, label, obj) {
        const levelObj = typeof level === 'string' 
            ? LOG_LEVELS[level.toUpperCase()] 
            : level;
            
        this.log(levelObj || LOG_LEVELS.INFO, `${label}:`);
        console.log(JSON.stringify(obj, null, 2));
    }

    // Create a divider line for visual separation in logs
    divider(char = '-', length = 80) {
        const line = char.repeat(length);
        console.log(this.options.enableColors ? COLORS.GRAY + line + COLORS.RESET : line);
    }

    // Log statistics in a formatted table
    stats(statistics) {
        this.divider();
        this.info('TRADING STATISTICS:');
        
        for (const [key, value] of Object.entries(statistics)) {
            const formattedValue = typeof value === 'number' && !Number.isInteger(value) 
                ? value.toFixed(2) 
                : value;
                
            console.log(`  ${COLORS.CYAN}${key}:${COLORS.RESET} ${formattedValue}`);
        }
        
        this.divider();
    }
}

module.exports = new Logger();