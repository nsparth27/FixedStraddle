# Straddle Signal

A local, read-only NSE F&O option-chain workspace. Select an underlying and expiry, choose one CE and one PE strike from Dhan's live option-chain snapshot, then save that custom pair to the local watchlist. The backend subscribes saved legs to Dhan's market feed and calculates the combined premium and 15-minute MACD/EMA signals.

## Start locally

1. Install Node.js 22 or later.
2. Double-click `start.bat` (or run `node server.mjs` and open `http://127.0.0.1:3000`).
3. Enter your Dhan Client ID and access token in the dashboard. Credentials stay in server memory and are cleared when it stops or when you disconnect.
4. Choose a stock or index and expiry, load the option chain, select one call and one put, and add the pair to your watchlist.

The detailed Dhan instrument master is downloaded once to `fno-universe.json` to build the active NSE F&O underlying/expiry list. The app no longer looks up a prior monthly expiry, future close, or expiry-day OI to pick strikes. You choose strikes yourself; displayed LTP, OI, and Greeks come from Dhan's current option-chain snapshot. Dhan limits option-chain requests to one request every three seconds, so changing underlyings/expiries may take a moment.

No orders are placed. The server binds to localhost only. Do not expose this app to the public internet.

## Watchlist and signals

- Custom CE/PE pairs are saved locally in `scanner.config.json` and survive a server restart.
- Dhan's market feed updates the selected option LTPs and summed straddle premium.
- Real-time continuous deployment to Render is supported via GitHub auto-sync.
- MACD (12/26/9) and EMA (200) use 15-minute combined-premium candles. Dhan historical candles for the manually selected legs are fetched only to initialize these indicators; historical prices and OI do not select strikes. Live feed candles take over as they arrive.
- 3-star alert: MACD is at or above zero. 5-star alert: MACD is at or above zero and combined premium is above EMA. These are informational alerts, not trading recommendations.
- The Stocks → 200 EMA page automatically scans the NSE equity universe, separately from the F&O straddle watchlist. It shows stocks whose last completed weekly close is within 5% above or below the 200-week EMA. It scans when Dhan connects and after Friday's market close; new listings remain in warm-up until 200 weekly closes are available.

`scanner.settings.json` stores editable indicator periods. Access tokens are not written to disk.
