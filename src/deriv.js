export class DerivClient {
  constructor(token, appId = "1089") {
    this.token = token;
    this.appId = appId;
    this.wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
  }

  async sendRequest(payload, requiresAuth = false) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      const timeout = setTimeout(() => { 
        try { ws.close(); } catch (_) {}
        reject(new Error("Deriv WS Timeout")); 
      }, 9000);

      ws.addEventListener('open', () => {
        if (requiresAuth && this.token) {
          ws.send(JSON.stringify({ authorize: this.token }));
        } else {
          ws.send(JSON.stringify(payload));
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
            // Authorized successfully, now send actual payload
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

  // Candles are fetched publicly (requiresAuth = false)
  async getCandles(symbol, count = 30) {
    try {
      const res = await this.sendRequest({
        ticks_history: symbol,
        adjust_start_time: 1,
        count: count,
        end: "latest",
        granularity: 900,
        style: "candles",
        req_type: "ticks_history"
      }, false); // Public request, no token needed

      if (!res || !res.candles || !Array.isArray(res.candles)) {
        console.warn(`[WARN] No candles returned for ${symbol}. Market may be closed.`);
        return [];
      }

      return res.candles.map(c => ({
        time: c.epoch, open: c.open, high: c.high, low: c.low, close: c.close
      }));
    } catch (err) {
      console.warn(`[WARN] Failed to fetch candles for ${symbol}: ${err.message}`);
      return [];
    }
  }

  // Trades require explicit authorization (requiresAuth = true)
  async executeTrade(symbol, direction, amount = 1.00, durationMinutes = 15) {
    if (!this.token) {
      throw new Error("DERIV_TOKEN is missing or undefined in environment variables.");
    }

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
    }, true);

    if (!res.buy) {
      throw new Error("Trade execution failed: No contract details returned.");
    }

    return res.buy;
  }

  async checkContractStatus(contractId) {
    const res = await this.sendRequest({
      proposal_open_contract: 1,
      contract_id: contractId,
      req_type: "proposal_open_contract"
    }, true);

    if (!res.proposal_open_contract) {
      throw new Error(`Unable to fetch status for contract ID: ${contractId}`);
    }

    return res.proposal_open_contract;
  }
}
