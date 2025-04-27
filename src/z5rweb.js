const EventEmitter = require('events');

class ILz5rweb extends EventEmitter {
  constructor(ip, port, key) {
    super();
    this.ip = ip;
    this.port = port;
    this.key = key;

    this.status = 'disconnected';
    this.enabled = true;


  }
  async get(oRequest) {
    if (DEBUG) debug('FN - get', oRequest);

  }

}

module.exports = ILz5rweb;