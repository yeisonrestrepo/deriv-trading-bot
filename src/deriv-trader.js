const { DerivAPI } = require('./deriv-api');
require('dotenv').config();

// Configuration
const CONFIG = {
    ALLOWED_SYMBOLS: ['1HZ10V', 'R_10', '1HZ25V', 'R_25', '1HZ50V', 'R_50', '1HZ75V', 'R_75', '1HZ100V', 'R_100', 'RDBEAR', 'RDBULL'],
    MARTINGALE_MULTIPLIERS: [0.35, 0.69, 1.39, 2.84, 5.8, 11.52, 23.51, 47.98],
    MAX_CONSECUTIVE_DIGITS: 3, // Number of consecutive odd/even digits to trigger a trade
    DEFAULT_SYMBOL: 'R_100',
    CURRENCY: 'USD',
    CONTRACT_DURATION: 1,
    CONTRACT_DURATION_UNIT: 't', // tick
};

class DerivTrader {
    constructor() {
        this.api = new DerivAPI();
        this.symbol = process.argv[2]?.toUpperCase() || CONFIG.DEFAULT_SYMBOL;
        this.maxTicks = parseInt(process.argv[3]) || CONFIG.MAX_CONSECUTIVE_DIGITS;
        
        // Trading state
        this.consecutiveOdd = 0;
        this.consecutiveEven = 0;
        this.lossCount = 0;
        this.ignoreTicks = false;
        this.activeContractId = null;
        this.tickSubscriptionId = null;
        this.predictedOutcome = null;
        this.currentContractType = null;
        
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
            this.stats.initialBalance = parseFloat(authResponse.authorize.balance);
            this.stats.currentBalance = this.stats.initialBalance;
            
            this.displayWelcomeMessage(authResponse);
            await this.startTrading();
            
            // Set up clean shutdown
            this.setupShutdownHandlers();
            
        } catch (error) {
            console.error('\x1b[31mInitialization Error:\x1b[0m', error.message || error);
            process.exit(1);
        }
    }
    
    validateInputs() {
        if (!CONFIG.ALLOWED_SYMBOLS.includes(this.symbol)) {
            throw new Error(`Symbol ${this.symbol} is not allowed. Valid symbols: ${CONFIG.ALLOWED_SYMBOLS.join(', ')}`);
        }
        
        if (isNaN(this.maxTicks) || this.maxTicks <= 0) {
            throw new Error('MAX_TICKS must be a positive number');
        }
    }
    
    displayWelcomeMessage(authData) {
        const welcomeMessage = `
*****************************************************************
*                   WELCOME TO DERIV TRADER                      *
*****************************************************************
\x1b[36mSYMBOL:\x1b[0m ${this.symbol}
\x1b[36mStrategy:\x1b[0m ODD/EVEN > ${this.maxTicks} consecutive digits
\x1b[36mDATE:\x1b[0m ${new Date().toLocaleString()}
\x1b[36mACCOUNT:\x1b[0m ${authData.authorize.loginid}
\x1b[36mINITIAL BALANCE:\x1b[0m ${authData.authorize.balance} ${authData.authorize.currency}
`;
        console.log(welcomeMessage);
    }
    
    async startTrading() {
        console.log('\x1b[33mStarting trade monitoring...\x1b[0m\n');
        await this.subscribeToTicks();
    }
    
    async subscribeToTicks() {
        try {
            const tickResponse = await this.api.send({
                ticks: this.symbol,
                subscribe: 1
            });
            
            this.tickSubscriptionId = tickResponse.subscription.id;
            console.log(`\x1b[36mSubscribed to ${this.symbol} tick stream\x1b[0m`);
            
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
            console.error('\x1b[31mError subscribing to ticks:\x1b[0m', error.message || error);
            throw error;
        }
    }
    
    processTick(tick) {
        if (this.ignoreTicks || this.activeContractId) {
            return;
        }
        
        const lastDigit = this.getLastDigit(tick.quote, tick.pip_size);
        const isEven = lastDigit % 2 === 0;
        
        // Update consecutive counters
        if (isEven) {
            this.consecutiveEven++;
            this.consecutiveOdd = 0;
            console.log(`\x1b[90mTick: ${tick.quote} (${lastDigit}) - Even (${this.consecutiveEven}/${this.maxTicks})\x1b[0m`);
        } else {
            this.consecutiveOdd++;
            this.consecutiveEven = 0;
            console.log(`\x1b[90mTick: ${tick.quote} (${lastDigit}) - Odd (${this.consecutiveOdd}/${this.maxTicks})\x1b[0m`);
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
            
            // Check if we've hit max consecutive losses
            if (this.lossCount >= CONFIG.MARTINGALE_MULTIPLIERS.length) {
                console.log('\x1b[31mReached maximum consecutive losses. Resetting strategy.\x1b[0m');
                this.resetStrategy();
                return;
            }
            
            // Determine stake amount using Martingale strategy
            const stake = CONFIG.MARTINGALE_MULTIPLIERS[this.lossCount];
            
            console.log(`\x1b[33mPlacing ${contractType} trade with stake ${stake} ${CONFIG.CURRENCY}\x1b[0m`);
            
            // Buy contract
            const contractResponse = await this.api.send({
                buy: 1,
                parameters: {
                    amount: stake,
                    basis: 'stake',
                    contract_type: contractType,
                    currency: CONFIG.CURRENCY,
                    duration: CONFIG.CONTRACT_DURATION,
                    duration_unit: CONFIG.CONTRACT_DURATION_UNIT,
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
            console.error('\x1b[31mError placing trade:\x1b[0m', error.message || error);
            this.resetStrategy();
        }
    }
    
    processContractUpdate(contract) {
        if (contract.contract_id !== this.activeContractId) {
            return;
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
                console.log(`\x1b[32mTrade WON: ${this.currentContractType} +${profit.toFixed(2)} ${CONFIG.CURRENCY}\x1b[0m`);
                this.resetStrategy();
            } else {
                this.stats.lostTrades++;
                console.log(`\x1b[31mTrade LOST: ${this.currentContractType} ${profit.toFixed(2)} ${CONFIG.CURRENCY}\x1b[0m`);
                this.lossCount++;
                this.prepareNextTrade();
            }
            
            // Display updated statistics
            this.displayTradeStats();
            
            // Unsubscribe from this contract
            this.api.send({
                forget: contract.id
            });
            
            this.activeContractId = null;
        }
    }
    
    prepareNextTrade() {
        // If we lost, prepare for next trade with same strategy
        this.ignoreTicks = false;
    }
    
    resetStrategy() {
        // Reset all trading state
        this.consecutiveOdd = 0;
        this.consecutiveEven = 0;
        this.lossCount = 0;
        this.ignoreTicks = false;
        this.activeContractId = null;
        this.currentContractType = null;
        this.predictedOutcome = null;
    }
    
    displayTradeStats() {
        const stats = `
\x1b[36mTRADING STATISTICS:\x1b[0m
Total Trades: ${this.stats.totalTrades}
Won: ${this.stats.wonTrades} (${this.stats.totalTrades > 0 ? ((this.stats.wonTrades / this.stats.totalTrades) * 100).toFixed(2) : 0}%)
Lost: ${this.stats.lostTrades}
Current Balance: ${this.stats.currentBalance.toFixed(2)} ${CONFIG.CURRENCY}
Profit/Loss: ${this.stats.profit >= 0 ? '\x1b[32m+' : '\x1b[31m'}${this.stats.profit.toFixed(2)}\x1b[0m ${CONFIG.CURRENCY}
`;
        console.log(stats);
    }
    
    setupShutdownHandlers() {
        process.on('SIGINT', async () => {
            await this.shutdown();
        });
        
        process.on('uncaughtException', async (error) => {
            console.error('\x1b[31mUncaught Exception:\x1b[0m', error);
            await this.shutdown();
        });
    }
    
    async shutdown() {
        console.log('\n\x1b[33mShutting down trading bot...\x1b[0m');
        
        // Display final statistics
        if (this.tickSubscriptionId) {
            try {
                await this.api.send({
                    forget: this.tickSubscriptionId
                });
                console.log('Unsubscribed from tick stream');
            } catch (error) {
                console.error('Error unsubscribing from ticks:', error.message);
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
            
            console.log(`
\x1b[36mFINAL TRADING SUMMARY:\x1b[0m
Initial Balance: ${this.stats.initialBalance.toFixed(2)} ${CONFIG.CURRENCY}
Final Balance: ${finalBalance.toFixed(2)} ${CONFIG.CURRENCY}
Total Profit/Loss: ${totalProfit >= 0 ? '\x1b[32m+' : '\x1b[31m'}${totalProfit.toFixed(2)}\x1b[0m ${CONFIG.CURRENCY}
Total Trades: ${this.stats.totalTrades}
Win Rate: ${this.stats.totalTrades > 0 ? ((this.stats.wonTrades / this.stats.totalTrades) * 100).toFixed(2) : 0}%
`);
        } catch (error) {
            console.error('Error getting final balance:', error.message);
        }
        
        // Disconnect from API
        this.api.disconnect();
        console.log('Disconnected from Deriv API');
        
        process.exit(0);
    }
}

// Create a .env file configuration for API credentials
const dotenvExample = `# Deriv API Credentials
APP_ID=74555
API_TOKEN=ZBsf8h8dXBU4h31
`;

const fs = require('fs');
if (!fs.existsSync('.env')) {
    fs.writeFileSync('.env', dotenvExample);
    console.log('Created .env file with default credentials. Please update with your own credentials.');
}

// Start the trader
const trader = new DerivTrader();
trader.initialize();