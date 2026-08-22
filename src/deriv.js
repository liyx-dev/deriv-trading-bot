export class DerivClient {
  constructor(token, appId = "1089") {
    this.token = token;
    this.appId = appId;
    this.wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
  }

  async sendRequest(payload, expectedType, requiresAuth = false) {
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
            ws.send(JSON.stringify(payload));
          } else if (
            data.msg_type === expectedType || 
            data.msg_type === 'history' || 
            data.msg_type === 'candles' || 
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
      // Stripped req_type from payload to fix Deriv API validation
      const res = await this.sendRequest({
        ticks_history: symbol,
        adjust_start_time: 1,
        count: count,
        end: "latest",
        granularity: 900, // 15-minute candles
        style: "candles"
      }, "candles", false);

      if (!res || !res.candles || !Array.isArray(res.candles)) {
        console.warn(`[WARN] No candles returned for ${symbol}. Market may be closed.`);
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
      }
    }, "buy", true);

    if (!res.buy) {
      throw new Error("Trade execution failed: No contract details returned.");
    }

    return res.buy;
  }

  async checkContractStatus(contractId) {
    const res = await this.sendRequest({
      proposal_open_contract: 1,
      contract_id: contractId
    }, "proposal_open_contract", true);

    if (!res.proposal_open_contract) {
      throw new Error(`Unable to fetch status for contract ID: ${contractId}`);
    }

    return res.proposal_open_contract;
  }
}

