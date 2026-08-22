export class DerivClient {
  constructor(token, appId = "1089") {
    this.token = token;
    this.appId = appId;
    this.wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
  }

  async sendRequest(payload) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      const timeout = setTimeout(() => { 
        try { ws.close(); } catch (_) {}
        reject(new Error("Deriv WS Timeout")); 
      }, 9000);

      ws.addEventListener('open', () => {
        if (payload.authorize) {
          ws.send(JSON.stringify(payload));
        } else {
          // Send authorize first if token is available, then command
          ws.send(JSON.stringify({ authorize: this.token }));
        }
      });

      ws.addEventListener('message', (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.error) {
            clearTimeout(timeout);
            ws.close();
            return reject(new Error(data.error.message || JSON.stringify(data.error)));
          }

          if (data.msg_type === 'authorize') {
            // Once authorized, send the main command payload
            ws.send(JSON.stringify(payload));
          } else if (
            data.msg_type === payload.req_type || 
            data.msg_type === 'ticks_history' || 
            data.msg_type === 'buy' || 
            data.msg_type === 'proposal_open_contract' ||
            data.msg_type === 'balance'
          ) {
            clearTimeout(timeout);
            ws.close();
            resolve(data);
          }
        } catch (err) {
          clearTimeout(timeout);
          ws.close();
          reject(err);
        }
      });

      ws.addEventListener('error', (err) => { 
        clearTimeout(timeout); 
        reject(new Error("WebSocket Connection Error: " + (err.message || "Failed to reach Deriv"))); 
      });
    });
  }

  async getCandles(symbol, count = 30) {
    try {
      const res = await this.sendRequest({
        ticks_history: symbol,
        adjust_start_time: 1,
        count: count,
        end: "latest",
        granularity: 900, // 15-minute candles
        style: "candles",
        req_type: "ticks_history"
      });

      // Defensive check: Return empty array if candles array is missing or undefined (e.g. weekend/closed market)
      if (!res || !res.candles || !Array.isArray(res.candles)) {
        console.warn(`[WARN] No candles returned for ${symbol}. Market may be closed or symbol invalid.`);
        return [];
      }

      return res.candles.map(c => ({
        time: c.epoch, 
        open: c.open, 
        high: c.high, 
        low: c.low, 
        close: c.close
      }));
    } catch (err) {
      console.warn(`[WARN] Failed to fetch candles for ${symbol}: ${err.message}`);
      return [];
    }
  }

  async executeTrade(symbol, direction, amount = 1.00, durationMinutes = 15) {
    const contractType = direction === "Rise" ? "CALL" : "PUT";
    const res = await this.sendRequest({
      buy: 1,
      price: amount,
      parameters: {
        amount: amount,
        basis: "stake",
        contract_type: contractType,
        currency: "USD",
        duration: durationMinutes,
        duration_unit: "m",
        symbol: symbol
      },
      req_type: "buy"
    });

    if (!res.buy) {
      throw new Error("Trade execution failed: No contract details returned.");
    }

    return res.buy; // Returns contract_id, transaction_id, etc.
  }

  async checkContractStatus(contractId) {
    const res = await this.sendRequest({
      proposal_open_contract: 1,
      contract_id: contractId,
      req_type: "proposal_open_contract"
    });

    if (!res.proposal_open_contract) {
      throw new Error(`Unable to fetch status for contract ID: ${contractId}`);
    }

    return res.proposal_open_contract;
  }

  async getAccountBalance() {
    const res = await this.sendRequest({
      balance: 1,
      req_type: "balance"
    });
    return res.balance ? res.balance.balance : 0;
  }
}
