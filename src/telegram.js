export async function sendTelegramMessage(botToken, chatId, text) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
  });
}

export function buildSignalMessage(symbolMap, symbol, direction, entryTime, closeTime) {
  const displayName = symbolMap[symbol] || symbol;
  return `🔔 *Signal Alert*\n\n` +
         `Pair: *${displayName}*\n` +
         `Direction: *${direction}*\n` +
         `Entry: *${entryTime}*\n` +
         `Close: *${closeTime}*\n\n` +
         `Nigeria Time 🇳🇬`;
}

export function buildReportMessage(trades, wins, losses, winRate, status) {
  return `📊 *Daily Report*\n\n` +
         `Trades: *${trades}*\n` +
         `Wins: *${wins}*\n` +
         `Losses: *${losses}*\n` +
         `Win Rate: *${winRate.toFixed(1)}%*\n` +
         `Status: *${status === 'ACTIVE' ? 'Continue trading' : 'Stopped for the day (Risk Triggered)'}*`;
}

