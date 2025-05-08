/**
 * Deriv Trader Bot - Main trading module
 * 
 * Automated trading bot for Deriv.com that implements an odd/even digit pattern strategy 
 * with Martingale progression.
 */

const { DerivAPI } = require('./deriv-api');
const config = require('./utils/config');
const logger = require('./utils/logger');

class DerivTrader {
    constructor() {
        this.api = new DerivAPI();
        this.symbol = config.get('DEFAULT_SYMBOL');
        this.maxTicks = config.get('MAX_CONSECUTIVE_DIGITS');
        
        // Trading state
        this.consecutiveOdd = 0;
        this.consecutiveEven = 0;
        this.lossCount = 0;
        this.ignoreTicks = false;
        this.activeContractId = null;
        this.tickSubscriptionId = null;
        this.predictedOutcome = null;
        this.currentContractType = null;
        this.nextTradeReady = false;
        this.predictionMade = false;
        this.pendingContractType = null; // Add this to track the next trade to place
                
        // Statistics
        this.stats = {
            totalTrades: 0,
            wonTrades: 0,
            lostTrades: 0,
            initialBalance: 0,
            currentBalance: 0,
            profit: 0
        };

    }

    async initialize() {
        try {
            this.validateInputs();
            await this.api.connect();
            
            // Authorize and get account info
            const authResponse = await this.api.authorize();
            console.log(authResponse.authorize.balance);
            this.stats.initialBalance = parseFloat(`${authResponse.authorize.balance}`);
            this.stats.currentBalance = this.stats.initialBalance;

            console.log('reach this stage');
            
            
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
        if (!config.get('ALLOWED_SYMBOLS').includes(this.symbol)) {
            throw new Error(`Symbol ${this.symbol} is not allowed. Valid symbols: ${config.get('ALLOWED_SYMBOLS').join(', ')}`);
        }
        
        if (isNaN(this.maxTicks) || this.maxTicks <= 0) {
            throw new Error('MAX_TICKS must be a positive number');
        }
    }
    
    displayWelcomeMessage(authData) {
        logger.divider('*', 65);
        logger.info('                   WELCOME TO DERIV TRADER                      ');
        logger.divider('*', 65);
        logger.info(`SYMBOL: ${this.symbol}`);
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
        logger.info('Starting trade monitoring...\n');
        await this.subscribeToTicks();
    }
    
    async subscribeToTicks() {
        try {
            const tickResponse = await this.api.send({
                ticks: this.symbol,
                subscribe: 1
            });
            
            this.tickSubscriptionId = tickResponse.subscription.id;
            logger.success(`Subscribed to ${this.symbol} tick stream`);
            
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
        const lastDigit = this.getLastDigit(tick.quote, tick.pip_size);
        const isEven = lastDigit % 2 === 0;
        
        // Check if we should place the next trade immediately based on prediction
        if (this.nextTradeReady && this.pendingContractType) {
            logger.info(`Placing predicted follow-up trade immediately: ${this.pendingContractType}`);
            this.placeTrade(this.pendingContractType);
            this.pendingContractType = null;
            this.nextTradeReady = false;
            return;
        }
        
        // If we're ignoring ticks, don't process further
        if (this.ignoreTicks) {
            return;
        }
        
        // Update consecutive counters
        if (isEven) {
            this.consecutiveEven++;
            this.consecutiveOdd = 0;
            logger.debug(`Tick: ${tick.quote} (${lastDigit}) - Even (${this.consecutiveEven}/${this.maxTicks})`);
        } else {
            this.consecutiveOdd++;
            this.consecutiveEven = 0;
            logger.debug(`Tick: ${tick.quote} (${lastDigit}) - Odd (${this.consecutiveOdd}/${this.maxTicks})`);
        }
        
        // Check if we should place a trade
        if (this.consecutiveEven >= this.maxTicks) {
            // After consecutive even digits, bet on ODD
            this.placeTrade('DIGITODD');
        } else if (this.consecutiveOdd >= this.maxTicks) {
            // After consecutive odd digits, bet on EVEN
            this.placeTrade('DIGITEVEN');
        }
    }
    
    getLastDigit(quote, pipSize) {
        return parseInt(quote.toFixed(pipSize).slice(-1));
    }
    
    async placeTrade(contractType) {
        try {
            // Ignore ticks while placing a trade
            this.ignoreTicks = true;
            this.currentContractType = contractType;
            this.predictionMade = false;
            this.pendingContractType = null;
            
            // Check if we've hit max consecutive losses
            const martingaleMultipliers = config.get('MARTINGALE_MULTIPLIERS');
            if (this.lossCount >= martingaleMultipliers.length) {
                logger.warning('Reached maximum consecutive losses. Resetting strategy.');
                this.resetStrategy();
                return;
            }
            
            // Determine stake amount using Martingale strategy
            const stake = martingaleMultipliers[this.lossCount];
            
            // Check if trading is enabled (for simulation mode)
            if (!config.get('TRADING_ENABLED')) {
                logger.trade(`[SIMULATION] Would place ${contractType} trade with stake ${stake} ${config.get('CURRENCY')}`);
                // Simulate a random win/loss outcome in simulation mode
                setTimeout(() => {
                    const randomOutcome = Math.random() > 0.5;
                    this.simulateTradeOutcome(randomOutcome, stake);
                }, 2000);
                return;
            }
            
            // Log the trade we're about to place
            logger.tradeStart(contractType, stake, this.symbol);
            
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
                    symbol: this.symbol
                }
            });
            
            if (contractResponse.error) {
                throw new Error(contractResponse.error.message);
            }
            
            this.activeContractId = contractResponse.buy.contract_id;
            this.stats.totalTrades++;
            
            // Subscribe to contract updates
            await this.api.send({
                proposal_open_contract: 1,
                contract_id: this.activeContractId,
                subscribe: 1
            });
            
        } catch (error) {
            logger.error('Error placing trade:', error.message || error);
            this.resetStrategy();
        }
    }
    
    // Simulate a trade outcome (for simulation mode)
    simulateTradeOutcome(isWin, stake) {
        const profit = isWin ? stake * 0.95 : -stake; // Assume 95% payout
        
        // Update statistics
        this.stats.totalTrades++;
        this.stats.currentBalance += profit;
        this.stats.profit += profit;
        
        if (isWin) {
            this.stats.wonTrades++;
            logger.tradeWin(this.currentContractType, profit.toFixed(2), this.stats.currentBalance.toFixed(2));
            this.resetStrategy();
        } else {
            this.stats.lostTrades++;
            logger.tradeLoss(this.currentContractType, Math.abs(profit).toFixed(2), this.stats.currentBalance.toFixed(2));
            this.lossCount++;
            this.prepareNextTrade();
        }
        
        // Display updated statistics
        this.displayTradeStats();
        this.ignoreTicks = false;
    }
    
    // Predict the contract outcome based on tick data
    predictContractStatus(contract) {
        if (!contract.tick_stream || contract.tick_stream.length === 0) {
            logger.debug('No tick stream available for prediction');
            return null;
        }
        
        // Get the current last digit from the exit tick or the latest tick in the stream
        const lastTickValue = contract.exit_tick_display_value || 
                             (contract.tick_stream.length > 0 ? 
                              contract.tick_stream[contract.tick_stream.length - 1].tick_display_value : 
                              null);
        
        if (!lastTickValue) {
            logger.debug('No tick value available for prediction');
            return null;
        }
        
        const lastDigit = Number(lastTickValue.slice(-1));
        const isEvenTick = (lastDigit % 2 === 0);
        
        logger.debug(`Predicting outcome based on last digit: ${lastDigit} (${isEvenTick ? 'Even' : 'Odd'})`);
        
        // Determine if we'll win or lose based on our contract type
        if ((isEvenTick && this.currentContractType === 'DIGITEVEN') || 
            (!isEvenTick && this.currentContractType === 'DIGITODD')) {
            return 'won';
        } else {
            return 'lost';
        }
    }
    
    processContractUpdate(contract) {
        if (contract.contract_id !== this.activeContractId) {
            return;
        }
        
        // Make prediction for early preparation of next trade if we haven't already
        if (!this.predictionMade && contract.tick_stream && contract.tick_stream.length > 0) {
            const prediction = this.predictContractStatus(contract);
            
            if (prediction === 'lost') {
                logger.warning(`Prediction: Contract LOST. Preparing next trade...`);
                
                // Increment loss count immediately for next trade preparation
                this.lossCount++;
                
                // Determine the next contract type based on current one
                this.pendingContractType = (this.currentContractType === 'DIGITEVEN') ? 'DIGITEVEN' : 'DIGITODD';
                
                // Set up for immediate next trade
                this.nextTradeReady = true;
                this.predictionMade = true;
                
                // Reset ignore ticks so we can process the next tick for immediate trading
                this.ignoreTicks = false;

                if (!this.predictionMade) {
                    this.lossCount++;
                    this.prepareNextTrade();
                }
                
            } else if (prediction === 'won') {
                logger.success(`Prediction: Contract WON`);
                this.predictionMade = true;
                
                // Reset strategy on win
                this.resetStrategy();
            }
        }
        
        // Only process when contract is finished
        if (contract.status === 'sold') {
            const isWin = contract.profit >= 0;
            const profit = parseFloat(contract.profit);
            
            // Update statistics
            this.stats.currentBalance = parseFloat(contract.balance_after);
            this.stats.profit += profit;
            
            if (isWin) {
                this.stats.wonTrades++;
                logger.tradeWin(this.currentContractType, profit.toFixed(2), this.stats.currentBalance.toFixed(2));
            } else {
                this.stats.lostTrades++;
                logger.tradeLoss(this.currentContractType, Math.abs(profit).toFixed(2), this.stats.currentBalance.toFixed(2));
            }
            
            // Display updated statistics
            this.displayTradeStats();
            
            // Check max loss limit if configured
            this.checkSafetyLimits();
            
            // Unsubscribe from this contract
            this.api.send({
                forget: contract.id
            });
            
            this.activeContractId = null;
        }
    }
    
    checkSafetyLimits() {
        // Check maximum consecutive losses
        const maxConsecutiveLosses = config.get('MAX_CONSECUTIVE_LOSSES');
        if (maxConsecutiveLosses && this.lossCount >= maxConsecutiveLosses) {
            logger.critical(`Safety limit reached: ${this.lossCount} consecutive losses`);
            this.shutdown();
            return;
        }
        
        // Check maximum daily loss
        const maxDailyLoss = config.get('MAX_DAILY_LOSS');
        if (maxDailyLoss && this.stats.profit <= -maxDailyLoss) {
            logger.critical(`Safety limit reached: Maximum daily loss of ${maxDailyLoss} exceeded`);
            this.shutdown();
            return;
        }
    }
    
    prepareNextTrade() {
        // If we lost, prepare for next trade with opposite contract type
        if (this.currentContractType) {
            this.pendingContractType = (this.currentContractType === 'DIGITEVEN') ? 'DIGITODD' : 'DIGITEVEN';
            logger.info(`Preparing next trade: ${this.pendingContractType} (after loss)`);
        }
        this.ignoreTicks = false;
    }
    
    resetStrategy() {
        // Reset all trading state
        logger.info('Resetting trading strategy...');
        this.consecutiveOdd = 0;
        this.consecutiveEven = 0;
        this.lossCount = 0;
        this.ignoreTicks = false;
        this.activeContractId = null;
        this.currentContractType = null;
        this.predictedOutcome = null;
        this.nextTradeReady = false;
        this.predictionMade = false;
        this.pendingContractType = null;
    }
    
    displayTradeStats() {
        const winRate = this.stats.totalTrades > 0 
            ? ((this.stats.wonTrades / this.stats.totalTrades) * 100).toFixed(2) 
            : 0;
            
        // Create statistics object
        const statistics = {
            'Total Trades': this.stats.totalTrades,
            'Won': `${this.stats.wonTrades} (${winRate}%)`,
            'Lost': this.stats.lostTrades,
            'Current Balance': `${this.stats.currentBalance.toFixed(2)} ${config.get('CURRENCY')}`,
            'Profit/Loss': `${this.stats.profit >= 0 ? '+' : ''}${this.stats.profit.toFixed(2)} ${config.get('CURRENCY')}`
        };
        
        // Log the statistics using the logger's stats method
        logger.stats(statistics);
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
        
        // Display final statistics
        if (this.tickSubscriptionId) {
            try {
                await this.api.send({
                    forget: this.tickSubscriptionId
                });
                logger.info('Unsubscribed from tick stream');
            } catch (error) {
                logger.error('Error unsubscribing from ticks:', error.message);
            }
        }
        
        // Get final balance
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