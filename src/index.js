import { getCycleTimes } from './utils.js';
import { DerivClient } from './deriv.js';
import { sendTelegramMessage, buildSignalMessage, buildReportMessage } from './telegram.js';

// Symbol Mapping for Deriv API symbols

// Optimized to 5 24/7 Synthetic Pairs to stay under Cloudflare CPU (10ms) & subrequest limits
const SYMBOLS = {
  "R_100": "Volatility 100 Index",
  "1HZ100V": "Volatility 100 (1s) Index",
  "R_75": "Volatility 75 Index",
  "1HZ50V": "Volatility 50 (1s) Index",
  "R_25": "Volatility 25 Index"

  /* --- Forex Pairs (Disabled for weekend / subrequest efficiency) ---
  "frxEURUSD": "EUR/USD",
  "frxGBPUSD": "GBP/USD",
  "frxUSDJPY": "USD/JPY",
  "frxAUDUSD": "AUD/USD",
  "frxUSDCAD": "USD/CAD"
  ------------------------------------------------------------------ */
};


export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/trigger") {
      const result = await runBotEngine(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response("Bot worker active. Use /trigger to execute manually.", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBotEngine(env));
  }
};

async function runBotEngine(env) {
  const deriv = new DerivClient(env.DERIV_TOKEN);
  const cycle = getCycleTimes();

  // 1. Check & Settle Any Completed Open Trades
  await settleOpenTrades(env, deriv);

  // 2. Check Daily Risk Gates
  const isEligible = await checkDailyRiskEligibility(env, cycle.todayDateStr);
  if (!isEligible.allowed) {
    return { status: "PAUSED", reason: isEligible.reason };
  }

  // 3. Ensure no overlapping active trade exists
  const activeTrade = await env.DB.prepare(
    "SELECT id FROM trades WHERE status = 'OPEN'"
  ).first();

  if (activeTrade) {
    return { status: "SKIPPED", reason: "An active trade is currently running." };
  }

  // 4. Evaluate Pairs for Technical Signals
  let selectedSignal = null;
  for (const [symbolCode, displayName] of Object.entries(SYMBOLS)) {
    try {
      console.log(`[DEBUG] Fetching candles for ${symbolCode}...`);
      const candles = await deriv.getCandles(symbolCode, 30);
      console.log(`[DEBUG] Received ${candles.length} candles for ${symbolCode}`);

      if (!candles || candles.length < 20) {
        console.log(`[DEBUG] Skipping ${symbolCode}: Insufficient candle data.`);
        continue;
      }

      const signal = evaluateMarketData(candles);
      console.log(`[DEBUG] ${symbolCode} Signal:`, JSON.stringify(signal));

      if (signal.direction !== "NEUTRAL" && signal.confidence >= 0.50) {
        selectedSignal = { symbol: symbolCode, displayName, ...signal };
        break; // Select first high-confidence pair
      }
    } catch (e) {
      console.error(`[ERROR] Processing ${symbolCode}:`, e.message || e);
    }
  }

  if (!selectedSignal) {
    return { status: "COMPLETED", result: "No high-confidence signals found." };
  }

  // 5. Execute Trade on Deriv
  const tradeAmount = 1.00; // Configurable stake amount
  let tradeResult;
  try {
    tradeResult = await deriv.executeTrade(
      selectedSignal.symbol,
      selectedSignal.direction,
      tradeAmount,
      15
    );
  } catch (err) {
    console.error("[ERROR] Deriv execution failed:", err.message);
    return { status: "ERROR", error: err.message };
  }

  // 6. Log Trade to Cloudflare D1 Database
  await env.DB.prepare(
    `INSERT INTO trades (deriv_contract_id, symbol, direction, amount, entry_time, close_time, status, trade_date)
     VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?)`
  ).bind(
    String(tradeResult.contract_id),
    selectedSignal.symbol,
    selectedSignal.direction,
    tradeAmount,
    String(cycle.entryTimestamp),
    String(cycle.closeTimestamp),
    cycle.todayDateStr
  ).run();

  // 7. Send Signal Notification to Telegram
  const msg = buildSignalMessage(
    SYMBOLS,
    selectedSignal.symbol,
    selectedSignal.direction,
    cycle.entryTimeFormatted,
    cycle.closeTimeFormatted
  );
  await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, msg);

  return { status: "SUCCESS", signal: selectedSignal, contract_id: tradeResult.contract_id };
}

// Technical Analysis Logic (EMA Cross + Momentum)
function evaluateMarketData(candles) {
  if (candles.length < 20) return { direction: "NEUTRAL", confidence: 0 };

  const closes = candles.map(c => c.close);
  const emaShort = calcEMA(closes, 9);
  const emaLong = calcEMA(closes, 21);

  const idx = closes.length - 1;
  const shortVal = emaShort[idx];
  const longVal = emaLong[idx];
  const prevShort = emaShort[idx - 1];
  const prevLong = emaLong[idx - 1];

  let direction = "NEUTRAL";
  let confidence = 0.50;

  // 1. Fresh Crossover (Highest Confidence)
  if (prevShort <= prevLong && shortVal > longVal) {
    direction = "Rise";
    confidence = 0.80;
  } else if (prevShort >= prevLong && shortVal < longVal) {
    direction = "Fall";
    confidence = 0.80;
  } 
  // 2. Strong Established Trend Continuation
  else if (shortVal > longVal && closes[idx] > shortVal) {
    direction = "Rise";
    confidence = 0.65;
  } else if (shortVal < longVal && closes[idx] < shortVal) {
    direction = "Fall";
    confidence = 0.65;
  }

  return { direction, confidence };
}

function calcEMA(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Risk Management & Daily Performance Logic
async function checkDailyRiskEligibility(env, todayStr) {
  let perf = await env.DB.prepare(
    "SELECT * FROM daily_performance WHERE trade_date = ?"
  ).bind(todayStr).first();

  if (!perf) {
    await env.DB.prepare(
      "INSERT INTO daily_performance (trade_date, total_trades, wins, losses, win_rate, status) VALUES (?, 0, 0, 0, 0.0, 'ACTIVE')"
    ).bind(todayStr).run();
    return { allowed: true };
  }

  if (perf.status === 'STOPPED') {
    return { allowed: false, reason: "Daily loss threshold hit. Trading halted for today." };
  }

  // Stop trading if losses exceed wins after at least 3 completed trades
  if (perf.total_trades >= 3 && perf.losses > perf.wins) {
    await env.DB.prepare(
      "UPDATE daily_performance SET status = 'STOPPED' WHERE trade_date = ?"
    ).bind(todayStr).run();

    const reportMsg = buildReportMessage(perf.total_trades, perf.wins, perf.losses, perf.win_rate, 'STOPPED');
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, reportMsg);

    return { allowed: false, reason: "Losses exceed wins. Risk engine halted trading for today." };
  }

  return { allowed: true };
}

// Settlement Engine for Completed Trades
async function settleOpenTrades(env, deriv) {
  const openTrades = await env.DB.prepare(
    "SELECT * FROM trades WHERE status = 'OPEN'"
  ).all();

  if (!openTrades || !openTrades.results || openTrades.results.length === 0) {
    return;
  }

  for (const trade of openTrades.results) {
    try {
      const contract = await deriv.checkContractStatus(trade.deriv_contract_id);
      if (contract && contract.is_expired) {
        const isWin = contract.status === "won";
        const newStatus = isWin ? "WON" : "LOST";
        const rawPayout = parseFloat(contract.pay_out) || 0;

        // 1. Update Trade Status in Database
        await env.DB.prepare(
          "UPDATE trades SET status = ?, payout = ? WHERE id = ?"
        ).bind(newStatus, rawPayout, trade.id).run();

        // 2. Fetch or Create Daily Performance
        let perf = await env.DB.prepare(
          "SELECT * FROM daily_performance WHERE trade_date = ?"
        ).bind(trade.trade_date).first();

        if (!perf) {
          await env.DB.prepare(
            "INSERT INTO daily_performance (trade_date, total_trades, wins, losses, win_rate, status) VALUES (?, 0, 0, 0, 0.0, 'ACTIVE')"
          ).bind(trade.trade_date).run();
          perf = { total_trades: 0, wins: 0, losses: 0 };
        }

        const wins = perf.wins + (isWin ? 1 : 0);
        const losses = perf.losses + (isWin ? 0 : 1);
        const total = perf.total_trades + 1;
        const winRate = parseFloat(((wins / total) * 100).toFixed(2));

        await env.DB.prepare(
          `UPDATE daily_performance 
           SET total_trades = ?, wins = ?, losses = ?, win_rate = ? 
           WHERE trade_date = ?`
        ).bind(total, wins, losses, winRate, trade.trade_date).run();

        // 3. Send Telegram Settlement Message
        const symbolDisplay = SYMBOLS[trade.symbol] || trade.symbol;
        const resultText = `📌 *Trade Outcome*\n\n` +
                           `Pair: *${symbolDisplay}*\n` +
                           `Result: *${isWin ? "✅ WIN" : "❌ LOSS"}*\n` +
                           `Payout: *$${rawPayout.toFixed(2)}*`;
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, resultText);
      }
    } catch (e) {
      console.error(`[ERROR] Failed to settle contract ${trade.deriv_contract_id}:`, e.message || e);
    }
  }
}

