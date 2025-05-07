# Deriv Trader Bot

A trading bot for Deriv.com that implements an odd/even digit pattern strategy with Martingale progression.

## Overview

This trading bot connects to the Deriv.com API and automatically places trades based on patterns in the last digits of price ticks. It uses a strategy where it monitors for consecutive odd or even digits and places trades predicting a reversal:

- After a streak of even digits, it bets on the next digit being odd
- After a streak of odd digits, it bets on the next digit being even

If a trade loses, it follows a Martingale strategy, increasing the stake amount for the next trade according to a predefined progression.

## Features

- Real-time connection to Deriv.com using WebSockets
- Configurable trading parameters
- Martingale stake progression for loss recovery
- Detailed trade statistics and logging
- Automatic reconnection on network failures
- Secure credential handling using environment variables

## Files

- `deriv-trader.js` - Main trading bot logic
- `deriv-api.js` - Secure WebSocket API wrapper for Deriv.com
- `.env` - Configuration file for API credentials (create from .env.sample)

## Setup

1. Install dependencies:
   ```
   npm install ws dotenv
   ```

2. Create a `.env` file with your Deriv API credentials:
   ```
   cp .env.sample .env
   ```
   Then edit the `.env` file with your actual APP_ID and API_TOKEN from Deriv.com

3. Run the bot:
   ```
   node deriv-trader.js [SYMBOL] [MAX_TICKS]
   ```
   
   Example:
   ```
   node deriv-trader.js R_100 3
   ```

## Command Line Arguments

- `SYMBOL`: The market symbol to trade (default: R_100)
- `MAX_TICKS`: Number of consecutive odd/even digits required to trigger a trade (default: 3)

## Supported Symbols

- Volatility Indices: 1HZ10V, R_10, 1HZ25V, R_25, 1HZ50V, R_50, 1HZ75V, R_75, 1HZ100V, R_100
- Boom/Crash Indices: RDBEAR, RDBULL

## Martingale Progression

The bot uses the following stake progression after consecutive losses:
[0.35, 0.69, 1.39, 2.84, 5.8, 11.52, 23.51, 47.98]

After 8 consecutive losses, the strategy resets.

## Security Warning

- Never commit your `.env` file with real API credentials to version control
- Keep your API token secure - it provides full access to your Deriv account

## Disclaimer

Trading involves significant risk. This bot is provided for educational purposes only. Use at your own risk.