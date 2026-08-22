export class DerivClient {
  constructor(token, appId = "34bGRqe9R3W91v5Fh52xw") {
    this.token = token;
    this.appId = appId;
    // Connects via Deriv's v3 WebSocket using your App ID
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
            // Once authorized, submit the trade payload
            ws.send(JSON.stringify(payload));
          } else if (
            data.msg_type === expectedType || 
            data.msg_type === 'history' || 
            data.msg_type === 'candles' || 
            data.msg_type === 'buy' || 
            data.msg_type === 'proposal_open_contract'
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
        granularity: 900,
        style: "candles"
      }, "candles", false);

      if (!res || !res.candles || !Array.isArray(res.candles)) {
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
      throw new Error("DERIV_TOKEN is missing or undefined in Cloudflare secret environment.");
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
}

