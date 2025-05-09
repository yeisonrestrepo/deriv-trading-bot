/**
 * Deriv Trader Bot - Main trading module
 * 
 * Automated trading bot for Deriv.com that implements an odd/even digit pattern strategy 
 * with Martingale progression, supporting multiple symbols simultaneously.
 */

const { DerivAPI } = require('./deriv-api');
const config = require('./utils/config');
const logger = require('./utils/logger');

class DerivTrader {
    constructor() {
        this.api = new DerivAPI();
        
        // List of symbols to trade (default: all allowed symbols)
        this.symbols = config.get('SYMBOLS_TO_TRADE') || config.get('ALLOWED_SYMBOLS');
        this.maxTicks = config.get('MAX_CONSECUTIVE_DIGITS');
        
        // Track state for each symbol independently
        this.symbolData = new Map();
        
        // Overall statistics
        this.stats = {
            totalTrades: 0,
            wonTrades: 0,
            lostTrades: 0,
            initialBalance: 0,
            currentBalance: 0,
            profit: 0,
            symbolPerformance: {}
        };
    }

    async initialize() {
        try {
            this.validateInputs();
            await this.api.connect();
            
            // Authorize and get account info
            const authResponse = await this.api.authorize();
            this.stats.initialBalance = parseFloat(`${authResponse.authorize.balance}`);
            this.stats.currentBalance = this.stats.initialBalance;
            
            this.displayWelcomeMessage(authResponse);
            await this.startTrading();
            
            // Set up clean shutdown
            this.setupShutdownHandlers();
            
        } catch (error) {
            logger.critical('Initialization Error:', error.message || error);
            process.exit(1);
        }
    }
    
    validateInputs() {
        // Validate each symbol
        for (const symbol of this.symbols) {
            if (!config.get('ALLOWED_SYMBOLS').includes(symbol)) {
                throw new Error(`Symbol ${symbol} is not allowed. Valid symbols: ${config.get('ALLOWED_SYMBOLS').join(', ')}`);
            }
        }
        
        if (isNaN(this.maxTicks) || this.maxTicks <= 0) {
            throw new Error('MAX_TICKS must be a positive number');
        }
    }
    
    displayWelcomeMessage(authData) {
        logger.divider('*', 65);
        logger.info('                WELCOME TO MULTI-SYMBOL DERIV TRADER              ');
        logger.divider('*', 65);
        logger.info(`TRADING SYMBOLS: ${this.symbols.join(', ')}`);
        logger.info(`Strategy: ODD/EVEN > ${this.maxTicks} consecutive digits`);
        logger.info(`DATE: ${new Date().toLocaleString()}`);
        logger.info(`ACCOUNT: ${authData.authorize.loginid}`);
        logger.info(`INITIAL BALANCE: ${authData.authorize.balance} ${authData.authorize.currency}`);
        logger.divider('-', 65);

        // Display configuration if in debug mode
        if (config.get('LOG_LEVEL') === 'DEBUG') {
            config.displayConfig();
        }
    }
    
    async startTrading() {
        logger.info('Starting multi-symbol trade monitoring...\n');
        
        // Initialize tracking for each symbol
        for (const symbol of this.symbols) {
            this.initializeSymbolData(symbol);
            
            // Set up per-symbol statistics
            this.stats.symbolPerformance[symbol] = {
                trades: 0,
                wins: 0,
                losses: 0,
                profit: 0
            };
        }
        
        // Subscribe to ticks for all symbols
        await this.subscribeToTicks();
    }
    
    initializeSymbolData(symbol) {
        this.symbolData.set(symbol, {
            consecutiveOdd: 0,
            consecutiveEven: 0,
            lossCount: 0,
            ignoreTicks: false,
            activeContractId: null,
            tickSubscriptionId: null,
            predictedOutcome: null,
            currentContractType: null,
            nextTradeReady: false,
            predictionMade: false,
            pendingContractType: null,
            lastDigit: null,
            lastUpdate: Date.now()
        });
    }
    
    async subscribeToTicks() {
        try {
            // Subscribe to each symbol
            for (const symbol of this.symbols) {
                const tickResponse = await this.api.send({
                    ticks: symbol,
                    subscribe: 1
                });
                
                const data = this.symbolData.get(symbol);
                data.tickSubscriptionId = tickResponse.subscription.id;
                logger.success(`Subscribed to ${symbol} tick stream`);
            }
            
            // Set up the event handler for incoming ticks
            this.api.socket.addEventListener('message', (event) => {
                const data = JSON.parse(event.data);
                
                if (data.msg_type === 'tick' && data.tick) {
                    this.processTick(data.tick);
                } else if (data.msg_type === 'proposal_open_contract' && data.proposal_open_contract) {
                    this.processContractUpdate(data.proposal_open_contract);
                }
            });
            
        } catch (error) {
            logger.error('Error subscribing to ticks:', error.message || error);
            throw error;
        }
    }
    
    processTick(tick) {
        const symbol = tick.symbol;
        
        // Skip if we're not tracking this symbol
        if (!this.symbolData.has(symbol)) {
            return;
        }
        
        const data = this.symbolData.get(symbol);
        const lastDigit = this.getLastDigit(tick.quote, tick.pip_size);
        const isEven = lastDigit % 2 === 0;
        
        // Update the last seen digit
        data.lastDigit = lastDigit;
        data.lastUpdate = Date.now();
        
        // Check if we should place the next trade immediately based on prediction
        if (data.nextTradeReady && data.pendingContractType) {
            logger.info(`[${symbol}] Placing predicted follow-up trade immediately: ${data.pendingContractType}`);
            this.placeTrade(symbol, data.pendingContractType);
            data.pendingContractType = null;
            data.nextTradeReady = false;
            return;
        }
        
        // If we're ignoring ticks for this symbol, don't process further
        if (data.ignoreTicks) {
            return;
        }
        
        // Update consecutive counters
        if (isEven) {
            data.consecutiveEven++;
            data.consecutiveOdd = 0;
            logger.debug(`[${symbol}] Tick: ${tick.quote} (${lastDigit}) - Even (${data.consecutiveEven}/${this.maxTicks})`);
        } else {
            data.consecutiveOdd++;
            data.consecutiveEven = 0;
            logger.debug(`[${symbol}] Tick: ${tick.quote} (${lastDigit}) - Odd (${data.consecutiveOdd}/${this.maxTicks})`);
        }
        
        // Check if we should place a trade
        if (data.consecutiveEven >= this.maxTicks) {
            // After consecutive even digits, bet on ODD
            this.placeTrade(symbol, 'DIGITODD');
        } else if (data.consecutiveOdd >= this.maxTicks) {
            // After consecutive odd digits, bet on EVEN
            this.placeTrade(symbol, 'DIGITEVEN');
        }
    }
    
    getLastDigit(quote, pipSize) {
        return parseInt(quote.toFixed(pipSize).slice(-1));
    }
    
    async placeTrade(symbol, contractType) {
        try {
            const data = this.symbolData.get(symbol);
            
            // Ignore ticks while placing a trade
            data.ignoreTicks = true;
            data.currentContractType = contractType;
            data.predictionMade = false;
            data.pendingContractType = null;
            
            // Check if we've hit max consecutive losses
            const martingaleMultipliers = config.get('MARTINGALE_MULTIPLIERS');
            if (data.lossCount >= martingaleMultipliers.length) {
                logger.warning(`[${symbol}] Reached maximum consecutive losses. Resetting strategy.`);
                this.resetStrategy(symbol);
                return;
            }
            
            // Determine stake amount using Martingale strategy
            const stake = martingaleMultipliers[data.lossCount];
            
            // Check if trading is enabled (for simulation mode)
            if (!config.get('TRADING_ENABLED')) {
                logger.trade(`[SIMULATION] [${symbol}] Would place ${contractType} trade with stake ${stake} ${config.get('CURRENCY')}`);
                // Simulate a random win/loss outcome in simulation mode
                setTimeout(() => {
                    const randomOutcome = Math.random() > 0.5;
                    this.simulateTradeOutcome(symbol, randomOutcome, stake);
                }, 2000);
                return;
            }
            
            // Log the trade we're about to place
            logger.tradeStart(contractType, stake, symbol);
            
            // Buy contract
            const contractResponse = await this.api.send({
                buy: 1,
                price: stake,
                parameters: {
                    amount: stake,
                    basis: 'stake',
                    contract_type: contractType,
                    currency: config.get('CURRENCY'),
                    duration: config.get('CONTRACT_DURATION'),
                    duration_unit: config.get('CONTRACT_DURATION_UNIT'),
                    symbol: symbol
                }
            });
            
            if (contractResponse.error) {
                throw new Error(contractResponse.error.message);
            }
            
            data.activeContractId = contractResponse.buy.contract_id;
            this.stats.totalTrades++;
            this.stats.symbolPerformance[symbol].trades++;
            
            // Subscribe to contract updates
            await this.api.send({
                proposal_open_contract: 1,
                contract_id: data.activeContractId,
                subscribe: 1
            });
            
        } catch (error) {
            logger.error(`[${symbol}] Error placing trade:`, error.message || error);
            this.resetStrategy(symbol);
        }
    }
    
    // Simulate a trade outcome (for simulation mode)
    simulateTradeOutcome(symbol, isWin, stake) {
        const data = this.symbolData.get(symbol);
        const profit = isWin ? stake * 0.95 : -stake; // Assume 95% payout
        
        // Update statistics
        this.stats.totalTrades++;
        this.stats.currentBalance += profit;
        this.stats.profit += profit;
        this.stats.symbolPerformance[symbol].trades++;
        this.stats.symbolPerformance[symbol].profit += profit;
        
        if (isWin) {
            this.stats.wonTrades++;
            this.stats.symbolPerformance[symbol].wins++;
            logger.tradeWin(`[${symbol}] ${data.currentContractType}`, profit.toFixed(2), this.stats.currentBalance.toFixed(2));
            this.resetStrategy(symbol);
        } else {
            this.stats.lostTrades++;
            this.stats.symbolPerformance[symbol].losses++;
            logger.tradeLoss(`[${symbol}] ${data.currentContractType}`, Math.abs(profit).toFixed(2), this.stats.currentBalance.toFixed(2));
            data.lossCount++;
            this.prepareNextTrade(symbol);
        }
        
        // Display updated statistics
        this.displayTradeStats();
        data.ignoreTicks = false;
    }
    
    // Predict the contract outcome based on tick data
    predictContractStatus(symbol, contract) {
        const data = this.symbolData.get(symbol);
        
        if (!contract.tick_stream || contract.tick_stream.length === 0) {
            logger.debug(`[${symbol}] No tick stream available for prediction`);
            return null;
        }
        
        // Get the current last digit from the exit tick or the latest tick in the stream
        const lastTickValue = contract.exit_tick_display_value || 
                             (contract.tick_stream.length > 0 ? 
                              contract.tick_stream[contract.tick_stream.length - 1].tick_display_value : 
                              null);
        
        if (!lastTickValue) {
            logger.debug(`[${symbol}] No tick value available for prediction`);
            return null;
        }
        
        const lastDigit = Number(lastTickValue.slice(-1));
        const isEvenTick = (lastDigit % 2 === 0);
        
        logger.debug(`[${symbol}] Predicting outcome based on last digit: ${lastDigit} (${isEvenTick ? 'Even' : 'Odd'})`);
        
        // Determine if we'll win or lose based on our contract type
        if ((isEvenTick && data.currentContractType === 'DIGITEVEN') || 
            (!isEvenTick && data.currentContractType === 'DIGITODD')) {
            return 'won';
        } else {
            return 'lost';
        }
    }
    
    processContractUpdate(contract) {
        // Find which symbol this contract belongs to
        let contractSymbol = null;
        let symbolData = null;
        
        for (const [symbol, data] of this.symbolData.entries()) {
            if (data.activeContractId === contract.contract_id) {
                contractSymbol = symbol;
                symbolData = data;
                break;
            }
        }
        
        if (!contractSymbol || !symbolData) {
            return; // Not one of our contracts
        }
        
        // Make prediction for early preparation of next trade if we haven't already
        if (!symbolData.predictionMade && contract.tick_stream && contract.tick_stream.length > 0) {
            const prediction = this.predictContractStatus(contractSymbol, contract);
            
            if (prediction === 'lost') {
                logger.warning(`[${contractSymbol}] Prediction: Contract LOST. Preparing next trade...`);
                
                // Increment loss count immediately for next trade preparation
                symbolData.lossCount++;
                
                // Determine the next contract type based on current one
                symbolData.pendingContractType = (symbolData.currentContractType === 'DIGITEVEN') ? 'DIGITEVEN' : 'DIGITODD';
                
                // Set up for immediate next trade
                symbolData.nextTradeReady = true;
                symbolData.predictionMade = true;
                
                // Reset ignore ticks so we can process the next tick for immediate trading
                symbolData.ignoreTicks = false;
                
            } else if (prediction === 'won') {
                logger.success(`[${contractSymbol}] Prediction: Contract WON`);
                symbolData.predictionMade = true;
                
                // Reset strategy on win
                this.resetStrategy(contractSymbol);
            }
        }
        
        // Only process when contract is finished
        if (contract.status === 'sold') {
            const isWin = contract.profit >= 0;
            const profit = parseFloat(contract.profit);
            
            // Update overall statistics
            this.stats.currentBalance = parseFloat(contract.balance_after);
            this.stats.profit += profit;
            
            // Update symbol-specific statistics
            this.stats.symbolPerformance[contractSymbol].profit += profit;
            
            if (isWin) {
                this.stats.wonTrades++;
                this.stats.symbolPerformance[contractSymbol].wins++;
                logger.tradeWin(`[${contractSymbol}] ${symbolData.currentContractType}`, profit.toFixed(2), this.stats.currentBalance.toFixed(2));
                this.resetStrategy(contractSymbol);
            } else {
                this.stats.lostTrades++;
                this.stats.symbolPerformance[contractSymbol].losses++;
                logger.tradeLoss(`[${contractSymbol}] ${symbolData.currentContractType}`, Math.abs(profit).toFixed(2), this.stats.currentBalance.toFixed(2));
                symbolData.lossCount++;
                this.prepareNextTrade(contractSymbol);
            }
            
            // Display updated statistics
            this.displayTradeStats();
            
            // Check max loss limit if configured
            this.checkSafetyLimits();
            
            // Unsubscribe from this contract
            this.api.send({
                forget: contract.id
            });
            
            symbolData.activeContractId = null;
        }
    }
    
    checkSafetyLimits() {
        // Check maximum consecutive losses for any symbol
        const maxConsecutiveLosses = config.get('MAX_CONSECUTIVE_LOSSES');
        if (maxConsecutiveLosses) {
            for (const [symbol, data] of this.symbolData.entries()) {
                if (data.lossCount >= maxConsecutiveLosses) {
                    logger.critical(`Safety limit reached: ${data.lossCount} consecutive losses on ${symbol}`);
                    this.shutdown();
                    return;
                }
            }
        }
        
        // Check maximum daily loss
        const maxDailyLoss = config.get('MAX_DAILY_LOSS');
        if (maxDailyLoss && this.stats.profit <= -maxDailyLoss) {
            logger.critical(`Safety limit reached: Maximum daily loss of ${maxDailyLoss} exceeded`);
            this.shutdown();
            return;
        }
    }
    
    prepareNextTrade(symbol) {
        const data = this.symbolData.get(symbol);
        
        // If we lost, prepare for next trade with opposite contract type
        if (data.currentContractType) {
            data.pendingContractType = (data.currentContractType === 'DIGITEVEN') ? 'DIGITODD' : 'DIGITEVEN';
            logger.info(`[${symbol}] Preparing next trade: ${data.pendingContractType} (after loss)`);
        }
        data.ignoreTicks = false;
    }
    
    resetStrategy(symbol) {
        const data = this.symbolData.get(symbol);
        
        // Reset all trading state for this symbol
        logger.info(`[${symbol}] Resetting trading strategy...`);
        data.consecutiveOdd = 0;
        data.consecutiveEven = 0;
        data.lossCount = 0;
        data.ignoreTicks = false;
        data.activeContractId = null;
        data.currentContractType = null;
        data.predictedOutcome = null;
        data.nextTradeReady = false;
        data.predictionMade = false;
        data.pendingContractType = null;
    }
    
    displayTradeStats() {
        const winRate = this.stats.totalTrades > 0 
            ? ((this.stats.wonTrades / this.stats.totalTrades) * 100).toFixed(2) 
            : 0;
            
        // Create overall statistics object
        const statistics = {
            'Total Trades': this.stats.totalTrades,
            'Won': `${this.stats.wonTrades} (${winRate}%)`,
            'Lost': this.stats.lostTrades,
            'Current Balance': `${this.stats.currentBalance.toFixed(2)} ${config.get('CURRENCY')}`,
            'Profit/Loss': `${this.stats.profit >= 0 ? '+' : ''}${this.stats.profit.toFixed(2)} ${config.get('CURRENCY')}`
        };
        
        // Log the overall statistics using the logger's stats method
        logger.stats(statistics);
        
        // Log per-symbol statistics if in detailed mode
        if (config.get('LOG_LEVEL') === 'DEBUG') {
            logger.divider('-', 50);
            logger.info('PERFORMANCE BY SYMBOL:');
            
            for (const symbol of this.symbols) {
                const symbolStats = this.stats.symbolPerformance[symbol];
                const symbolWinRate = symbolStats.trades > 0 
                    ? ((symbolStats.wins / symbolStats.trades) * 100).toFixed(2) 
                    : 0;
                
                logger.info(`${symbol}: ${symbolStats.trades} trades, ${symbolWinRate}% win rate, ${symbolStats.profit >= 0 ? '+' : ''}${symbolStats.profit.toFixed(2)} ${config.get('CURRENCY')}`);
            }
        }
    }
    
    setupShutdownHandlers() {
        process.on('SIGINT', async () => {
            await this.shutdown();
        });
        
        process.on('uncaughtException', async (error) => {
            logger.critical('Uncaught Exception:', error);
            await this.shutdown();
        });
    }
    
    async shutdown() {
        logger.info('\nShutting down trading bot...');
        
        // Unsubscribe from all tick streams
        for (const [symbol, data] of this.symbolData.entries()) {
            if (data.tickSubscriptionId) {
                try {
                    await this.api.send({
                        forget: data.tickSubscriptionId
                    });
                    logger.info(`Unsubscribed from ${symbol} tick stream`);
                } catch (error) {
                    logger.error(`Error unsubscribing from ${symbol} ticks:`, error.message);
                }
            }
        }
        
        // Display final statistics
        try {
            const balanceResponse = await this.api.send({
                balance: 1,
                account: 'current'
            });
            
            const finalBalance = parseFloat(balanceResponse.balance.balance);
            const totalProfit = finalBalance - this.stats.initialBalance;
            
            logger.divider('=', 65);
            logger.info('FINAL TRADING SUMMARY:');
            logger.info(`Initial Balance: ${this.stats.initialBalance.toFixed(2)} ${config.get('CURRENCY')}`);
            logger.info(`Final Balance: ${finalBalance.toFixed(2)} ${config.get('CURRENCY')}`);
            logger.info(`Total Profit/Loss: ${totalProfit >= 0 ? '+' : ''}${totalProfit.toFixed(2)} ${config.get('CURRENCY')}`);
            logger.info(`Total Trades: ${this.stats.totalTrades}`);
            logger.info(`Win Rate: ${this.stats.totalTrades > 0 ? ((this.stats.wonTrades / this.stats.totalTrades) * 100).toFixed(2) : 0}%`);
            
            // Display per-symbol results
            logger.divider('-', 65);
            logger.info('SYMBOL PERFORMANCE:');
            
            for (const symbol of this.symbols) {
                const symbolStats = this.stats.symbolPerformance[symbol];
                const symbolWinRate = symbolStats.trades > 0 
                    ? ((symbolStats.wins / symbolStats.trades) * 100).toFixed(2) 
                    : 0;
                
                logger.info(`${symbol}: ${symbolStats.trades} trades, ${symbolStats.wins} wins, ${symbolStats.losses} losses (${symbolWinRate}% win rate)`);
                logger.info(`${symbol} Profit/Loss: ${symbolStats.profit >= 0 ? '+' : ''}${symbolStats.profit.toFixed(2)} ${config.get('CURRENCY')}`);
            }
            
            logger.divider('=', 65);
        } catch (error) {
            logger.error('Error getting final balance:', error.message);
        }
        
        // Disconnect from API
        this.api.disconnect();
        logger.info('Disconnected from Deriv API');
        
        process.exit(0);
    }
}

// Start the trader
const trader = new DerivTrader();
trader.initialize();