export class DerivClient {
  constructor(token, appId = "1089") {
    this.token = token;
    this.appId = appId;
    this.wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
  }

  async sendRequest(payload) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      const timeout = setTimeout(() => { ws.close(); reject(new Error("Deriv WS Timeout")); }, 8000);

      ws.addEventListener('open', () => {
        if (payload.authorize) {
          ws.send(JSON.stringify(payload));
        } else {
          // Send authorize first if token available, then command
          ws.send(JSON.stringify({ authorize: this.token }));
        }
      });

      ws.addEventListener('message', (event) => {
        const data = JSON.parse(event.data);
        if (data.msg_type === 'authorize') {
          ws.send(JSON.stringify(payload));
        } else if (data.msg_type === payload.req_type || data.msg_type === 'ticks_history' || data.msg_type === 'buy' || data.msg_type === 'proposal_open_contract') {
          clearTimeout(timeout);
          ws.close();
          resolve(data);
        } else if (data.error) {
          clearTimeout(timeout);
          ws.close();
          reject(data.error);
        }
      });

      ws.addEventListener('error', (err) => { clearTimeout(timeout); reject(err); });
    });
  }

  async getCandles(symbol, count = 30) {
    const res = await this.sendRequest({
      ticks_history: symbol,
      adjust_start_time: 1,
      count: count,
      end: "latest",
      granularity: 900, // 15-minute candles
      style: "candles",
      req_type: "ticks_history"
    });
    return res.candles.map(c => ({
      time: c.epoch, open: c.open, high: c.high, low: c.low, close: c.close
    }));
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
    return res.buy; // Returns contract_id and transaction_id
  }

  async checkContractStatus(contractId) {
    const res = await this.sendRequest({
      proposal_open_contract: 1,
      contract_id: contractId,
      req_type: "proposal_open_contract"
    });
    return res.proposal_open_contract;
  }
}

