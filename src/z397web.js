const EventEmitter = require('events');
const Net = require('net');

const DEBUG = false;

// Класс, обмен данными с конвертером ironLogic Z397-web
class ILz397web extends EventEmitter {
  /**
   * Пераметры:
   *   ip    {string} - IP адресс конвертера
   *   port  {number} - порт, который слушает конвертер
   *   key   {string} - ключ авторизации конвертера
   *
   * Свойства:
   *   status  {string} - 'disconnected'/'connecting'/'connected' статус соединения
   *   enabled {boolean} - включено ли соединение?
   *
   * Методы:
   *   async get() - принимает команду в виде объекта:
   *    {
   *      id: "id запроса",
   *      request: {
   *        addr: "адрес контроллера или null",
   *        cmd: 'команда'
   *      }
   *    }
   *    Возвращает Promise с объектом вида:
   *    {
   *      id: "id запроса",
   *      error: "ошибка или null",
   *      responce: {
   *        addr: "адрес контроллера или null",
   *        cmd: "команда указаная в запросе",
   *        data: ["непосредственно ответ или null при ошибке"]
   *      }
   *    }
   *    Команды:
   *      'connect' - установить подключение к конвертеру, возвращает 'connected'
   *      'disconnect' - отключиться от конвертера, возвращает 'disconnected'
   *      'reset' - перезагрузить конвертер, возвращает 'reset'
   *      'scan' - сканировать шину, возвращает адреса контроллеров в виде массива
   *      'get_sn' - запрос серийного номера контроллера с адресом addr, возвращает серийный номер
   *      'get_time' - запрос текущего времени на контроллере с адресом addr, возвращает время в виде UNIX timestamp
   *      'set_time' - установка времени на контроллере с адресом addr на текущее, возвращает 'ok'
   *      'open' - открывает замок, возвращает 'ok'
   */
  constructor(ip, port, key) {
    super();
    this.ip = ip;
    this.port = port;
    this.key = key;

    this.status = 'disconnected';
    this.enabled = true;

    this._buffer = [];
    this._rxState = false;
    this._msgAdvModeOn = Buffer.from([0xff, 0xfa, 0x2c, 0x01, 0x00, 0x03, 0x84, 0x00, 0xff, 0xf0]);
    this._startBytes = [0x1e, 0x20, 0x1f, 0x02];
    this.respProto = { id: null, error: null, responce: { addr: null, cmd: null, data: null } };
  }

  // обработчик команд
  async get(oRequest) {
    if (DEBUG) debug('FN - get', oRequest);

    const resp = { id: oRequest.id, error: null, responce: { addr: null, cmd: oRequest.request.cmd, data: null } };

    if (oRequest.request.cmd === 'connect') {
      return new Promise((resolve, reject) => {
        if (this.status === 'disconnected') {
          this._init();
          this.once('init', (status) => {
            this.enabled = true;
            resp.responce.data = status;
            resolve(resp);
          });
          this.once('error', (err) => {
            resp.error = err;
            reject(resp);
          });
        } else {
          resp.error = 'Уже подключено';
          reject(resp);
        }
      });
    }

    if (oRequest.request.cmd === 'disconnect') {
      return new Promise((resolve, reject) => {
        if (this.status === 'connected') {
          this._tcpClient.destroy();
          this.once('close', (status) => {
            this._tcpClient = null;
            this.enabled = false;
            resp.responce.data = status;
            resolve(resp);
          });
          this.once('error', (err) => {
            resp.error = err;
            reject(resp);
          });
        } else {
          resp.error = 'Уже отключено';
          reject(resp);
        }
      });
    }

    if (oRequest.request.cmd === 'reset') {
      return new Promise((resolve, reject) => {
        // закрывает соединение и устанавливает новое telnet соединение для отправки команды на перезагрузку
        this._tcpClient.destroy();
        this._tcpClient = null;
        let telnet = new Net.Socket();
        const inTelnet = [];
        let telnetConnected = false;
        telnet.connect(23, this.ip, () => {
          telnetConnected = true;
        });
        telnet.on('data', (data) => {
          inTelnet.push(data.toString());
          if (inTelnet.length === 2 && inTelnet[inTelnet.length - 1] == '> ') {
            telnet.write(`${this.key}\r\n`);
          }
          if (inTelnet.length === 4 && inTelnet[inTelnet.length - 1] == '> ') {
            telnet.write('rst\r\n');
            telnet.destroy();
            telnet = {};
            setTimeout(() => {
              resp.responce.data = 'reset';
              resolve(resp);
            }, 3000);
          }
        });
        telnet.on('error', (err) => {
          if (telnetConnected) this.telnet.destroy();
          resp.error = err.code;
          reject(resp);
        });
      });
    }

    if (this.status === 'connected' && oRequest.id >= 0x00 && oRequest.id < 0xff) {
      return new Promise((resolve, reject) => {
        let { addr, cmd } = oRequest.request;
        addr = addr >= 0x02 && addr <= 0x69 ? addr : null;
        switch (cmd) {
          case 'scan':
            this._send(this._makeScanPacket(oRequest.id));
            break;
          case 'get_sn':
            if (addr) this._send(this._makeGetSnPacket(oRequest.id, addr));
            break;
          case 'get_time':
            if (addr) this._send(this._makeGetTimePacket(oRequest.id, addr));
            break;
          case 'set_time':
            if (addr) this._send(this._makeSetTimePacket(oRequest.id, addr));
            break;
          case 'open':
            if (addr) this._send(this._makeOpenDoorPacket(oRequest.id, addr));
            break;
        }
        this.once('receive', (resp) => {
          resolve(resp);
        });
        this.once('error', (err) => {
          resp.error = err;
          reject(resp);
        });
      });
    }
  }

  // устанавливает подключение и обрабатывает события связаные с подключением
  _init() {
    if (DEBUG) debug('FN - _init');

    this._tcpClient = new Net.Socket();

    this._tcpClient.connect(this.port, this.ip, () => {
      this.status = 'connecting';
    });

    this._tcpClient.on('connect', () => {
      this.status = 'connected';
      this._send(this._msgAdvModeOn);
      this.emit('init', this.status);
    });

    this._tcpClient.on('data', (data) => {
      let oPacket = this._unpacking(this._receivingData(data));
      if (oPacket.packet !== null) {
        if (this._checkSum(oPacket.packet)) {
          this._handlerReceivedData(oPacket);
        }
      }
    });

    this._tcpClient.on('error', (err) => {
      try {
        this.emit('error', err.code);
      } catch (err) {
        if (DEBUG) debug('init catch', err.code);
      }
      // if (err.code === 'ECONNREFUSED') {
      //   this.reset();
      // }
      this._tcpClient.destroy();
    });

    this._tcpClient.on('close', () => {
      this.status = 'disconnected';
      this.emit('close', this.status);
    });
  }

  // обрабатывает распакованый пакет
  _handlerReceivedData(oData) {
    if (DEBUG) debug('FN - _handlerReceivedData');

    const iType = oData.type;
    const aPacket = oData.packet;
    let resp = {};
    if (iType === 0x20 && aPacket[0x04] === 0x00 && aPacket[0x05] == 0x00) {
      resp = { ...this._parseScanResp(aPacket) };
    } else if (iType === 0x20 && aPacket[0x04] === 0x00 && aPacket[0x05] >= 0x02) {
      resp = { ...this._parseGetSnResp(aPacket) };
    } else if (iType === 0x1f && aPacket[0x04] === 0x02 && aPacket[0x07] >= 0xd0) {
      resp = { ...this._parseGetTime(aPacket) };
    } else if (iType === 0x1f && aPacket[0x04] === 0x03 && aPacket[0x08] >= 0x55) {
      resp = { ...this._parseSetTime(aPacket) };
    } else if (iType === 0x1f && aPacket[0x04] === 0x07 && aPacket[0x08] >= 0x55) {
      resp = { ...this._parseOpen(aPacket) };
    } else if (DEBUG) debug('_handlerReceivedData', aPacket);
    if (resp.error) this.emit('error', resp);
    else this.emit('receive', resp);
  }

  // парсит пакет с ответом на команду сканирования
  _parseScanResp(data) {
    if (DEBUG) debug('FN - _parseScanResp');

    const resp = { id: data[3], error: null, responce: { addr: data[5], cmd: 'scan', data: [] } };
    let scanMask = data.slice(8);
    for (let i = 0; i < scanMask.length; i++) {
      for (let k = 0; k < 8; k++) {
        if (scanMask[i] & (1 << k)) {
          const addr = i * 8 + k + 2;
          resp.responce.data.push(addr);
        }
      }
    }
    return resp;
  }

  // парсит пакет с ответом на команду запроса серийного номера
  _parseGetSnResp(data) {
    if (DEBUG) debug('FN - _parseGetSnResp', data);

    const resp = { id: data[3], error: null, responce: { addr: data[5], cmd: 'get_sn', data: [] } };
    if (data[5] >> 7 || (data[6] === 0x00 && data[7] === 0x00)) {
      this.emit('error', 'controller not found');
    } else {
      resp.responce.data.push((data[7] << 8) | data[6]);
    }
    return resp;
  }

  // парсит пакет с ответом на команду запроса текущего времени
  _parseGetTime(data) {
    if (DEBUG) debug('FN - _parseGetTime');

    const resp = { id: data[3], error: null, responce: { addr: data[5], cmd: 'get_time', data: [] } };
    let time = +new Date(
      parseInt('20' + data[0x0e].toString(16), 10),
      parseInt(data[0x0d].toString(16), 10) - 1,
      parseInt(data[0x0c].toString(16), 10),
      parseInt(data[0x0a].toString(16), 10),
      parseInt(data[0x09].toString(16), 10),
      parseInt(data[0x08].toString(16), 10)
    );
    resp.responce.data.push(time);
    return resp;
  }

  // парсит пакет с ответом на команду установки текущего времени
  _parseSetTime(data) {
    if (DEBUG) debug('FN - _parseSetTime');

    return { id: data[3], error: null, responce: { addr: data[5], cmd: 'set_time', data: ['ok'] } };
  }

  // парсит пакет с ответом на команду открытия замка
  _parseOpen(data) {
    if (DEBUG) debug('FN - _parseOpen');
    return { id: data[3], error: null, responce: { addr: data[5], cmd: 'open', data: ['ok'] } };
  }

  // формирует пакет сканирования шины
  _makeScanPacket(id) {
    if (DEBUG) debug('FN - _makeScanPacket');
    const cmdType = 0x20;
    const packet = [0x08, 0xff, 0x00, 0x00, 0x00, 0x00];
    return Buffer.from(this._assembing(cmdType, id, packet));
  }

  // формирует пакет запроса детальной информации о контроллере
  _makeGetSnPacket(id, addr) {
    if (DEBUG) debug('FN - _makeGetSnPacket');
    let cmdType = 0x20;
    const packet = [0x08, 0xff, 0x00, 0xff, 0x00, 0x00];
    packet[3] = addr;
    return Buffer.from(this._assembing(cmdType, id, packet));
  }

  // формирует пакет открытия двери
  _makeOpenDoorPacket(id, addr) {
    if (DEBUG) debug('FN - _makeOpenDoorPacket');
    const cmdType = 0x1f;
    const packet = [0x08, 0xff, 0x07, 0xff, 0x00, 0x00];
    packet[3] = addr;
    return Buffer.from(this._assembing(cmdType, id, packet));
  }

  // формирует пакет установки текущего времени контроллера
  _makeSetTimePacket(id, addr) {
    if (DEBUG) debug('FN - _makeSetTimePacket');
    let cmdType = 0x1f;
    const packet = [0x08, 0xff, 0x03, 0xff, 0x00, 0xd0, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    packet[0x03] = addr;
    let date = new Date();
    packet[0x09] = parseInt(date.getSeconds().toString(10), 16);
    packet[0x0a] = parseInt(date.getMinutes().toString(10), 16);
    packet[0x0b] = parseInt(date.getHours().toString(10), 16);
    packet[0x0c] = parseInt((date.getDay() ? date.getDay() : 7).toString(10), 16);
    packet[0x0d] = parseInt(date.getDate().toString(10), 16);
    packet[0x0e] = parseInt((date.getMonth() + 1).toString(10), 16);
    packet[0x0f] = parseInt(date.getFullYear().toString(10).slice(-2), 16);
    return Buffer.from(this._assembing(cmdType, id, packet));
  }

  // формирует пакет запроса текущего времени контроллера
  _makeGetTimePacket(id, addr) {
    if (DEBUG) debug('FN - _makeGetTimePacket');
    let cmdType = 0x1f;
    const packet = [0x08, 0xff, 0x02, 0xff, 0x00, 0xd0, 0x07, 0x00, 0x00, 0x00];
    packet[3] = addr;
    return Buffer.from(this._assembing(cmdType, id, packet));
  }

  // Отправляет готовый пакет
  _send(data) {
    if (DEBUG) debug('FN - _send');

    if (this.status === 'connected') {
      this._tcpClient.write(data);
    } else this.emit('error', 'not connected');
  }

  // проверяет принятые данные на:
  // - началась ли новая передача или продолжается предыдущая
  // - получен ли конец пакета
  // - не пришло ли сообщение об ошибке протокола "Advanced"
  // если все хорошо, возвращает объект с типом команды, id передачи = null, готовым к распаковке пакетом
  _receivingData(aData) {
    if (DEBUG) debug('FN - _receivingData');

    let rxIndex = 0;
    let packet = [];
    let cmdType;

    if (this._startBytes.indexOf(aData[0]) != -1) {
      cmdType = aData[0];
      this._rxState = true;
      this._buffer = [];
      rxIndex = 0;
    }

    if (this._rxState) {
      for (const el of aData) {
        this._buffer[rxIndex++] = el;
        if (el == 0x0d) {
          this._rxState = false;
          packet = [...this._buffer];
          break;
        }
      }
    }

    if (!this._rxState) {
      if (cmdType === 0x02) {
        packet.shift();
        let error;
        switch (aData[2]) {
          case 0x48:
            error = 'checkReceivedData - ERROR CRC';
            break;
          case 0x4c:
            switch (aData[3]) {
              case 0x43:
                error = 'checkReceivedData - ERROR lisense command';
                break;
              case 0x31:
                error = 'checkReceivedData - ERROR lisense not active';
                break;
              case 0x32:
                error = 'checkReceivedData - ERROR lisense is old';
                break;
              case 0x33:
                error = 'checkReceivedData - ERROR too many controllers';
                break;
              case 0x34:
                error = 'checkReceivedData - ERROR read too many cards';
                break;
              case 0x35:
                error = 'checkReceivedData - ERROR write too many cards';
                break;
              case 0x36:
                error = 'checkReceivedData - ERROR write lisense is old';
                break;
            }
            break;
          case 0x43:
            error = 'checkReceivedData - ERROR not found controller';
            break;
          case 0x4a:
            error = 'checkReceivedData - ERROR packet first byte';
            break;
        }
        this.emit('error', error);
        return { type: null, id: null, packet: [] };
      } else {
        packet.pop();
        packet.shift();
        return { type: cmdType, id: null, packet: packet };
      }
    }
  }

  // проверяет контрольную сумму и заявленую длину полученного пакета
  _checkSum(data) {
    if (DEBUG) debug('FN - _checkSum');
    let packet = [...data].slice(0, data[1]);
    let sum = 0;
    let length = packet.length;
    let declaredSum = packet.shift();
    let declaredLength = packet[1];
    for (let i = 0; i < packet.length; i++) {
      sum += packet[i];
    }
    sum = (sum & 0xff) ^ 0xff;
    if (declaredSum === sum || declaredLength === length) {
      return true;
    } else {
      return false;
    }
  }

  // собирает готовый к отправке в конвертер пакет
  _assembing(iType, iId, data) {
    if (DEBUG) debug('FN - _assembing');
    let packet = data;
    packet[1] = iId;
    let out = [];
    out = out.concat(packet);
    out.unshift(0x00, 0x00);
    out[1] = out.length;
    let sum = 0;
    for (var i = 0; i < out.length; i++) sum += out[i];
    out[0] = 0xff - (sum & 0xff);
    while (out.length % 4 != 0) out.push(0);
    out = this._packing(out);
    out.unshift(iType);
    out.push(0x0d);
    return out;
  }

  // распаковывает полученый от конвертера пакет
  _unpacking(oData) {
    if (DEBUG) debug('FN - _unpacking');
    let iType = oData.type;
    let iId = oData.id;
    let aPacket = oData.packet;
    const temp_in = [0, 0, 0, 0, 0];
    const outPacket = [];
    for (let i = 0; i < aPacket.length; i++) {
      temp_in[i % 5] = aPacket[i];
      if ((i + 1) % 5 == 0) {
        const temp_out = [0, 0, 0, 0];
        for (let k = 0; k < 5; k++) if (temp_in[k] & 0x80) temp_in[k] ^= 0xca;
        for (let k = 0; k < 4; k++) temp_out[k] = temp_in[k] | (((temp_in[4] >> k) & 1) << 7);
        outPacket.push(...temp_out);
      }
    }
    iId = outPacket[3];
    return { type: iType, id: iId, packet: outPacket };
  }

  // запаковывает сформированый пакет
  _packing(data) {
    if (DEBUG) debug('FN - _packing');
    const temp_in = [0, 0, 0, 0];
    let out = [];
    for (let i = 0; i < data.length; i++) {
      temp_in[i % 4] = data[i];
      if ((i + 1) % 4 == 0) {
        const temp_out = [0, 0, 0, 0, 0];
        temp_out[0] =
          ((temp_in[0] & 0x80) >> 4) +
          ((temp_in[1] & 0x80) >> 5) +
          ((temp_in[2] & 0x80) >> 6) +
          ((temp_in[3] & 0x80) >> 7);
        for (let k = 0; k < 4; k++) temp_out[k + 1] = temp_in[k] & 0x7f;
        for (let k = 0; k < 5; k++) if (temp_out[k] < 48) temp_out[k] ^= 0xca;
        out = out.concat(temp_out);
      }
    }
    return out;
  }
}


if (DEBUG) {
  const iL = new ILz397web('192.168.14.9', 1000, '2B07D1B1');
  // const iL = new ILz397web('192.168.1.115', 1000, '8C0552F2');

  let id = 0;
  async function iL1run() {
    let resp;
    let addreses = [];
    const controllers = {};
    debug('STA', iL.status);
    if (iL.status === 'disconnected') {
      try {
        resp = await iL.get({ id: id++, request: { addr: null, cmd: 'connect' } });
        debug('CON', resp);
      } catch (err) {
        debug('ERROR', err);
      }
    }
    debug('STA', iL.status);
    if (iL.status === 'connected') {
      try {
        resp = await iL.get({ id: id++, request: { addr: null, cmd: 'scan' } });
        addreses = [...resp.responce.data];
        debug('SCN', resp, addreses);
      } catch (err) {
        debug('ERROR', err);
      }
    }
    debug('STA', iL.status);
    if (iL.status === 'connected') {
      try {
        for (addr of addreses) {
          resp = await iL.get({ id: id++, request: { addr: addr, cmd: 'get_sn' } });
          controllers[addr] = { sn: resp.responce.data };
          debug('GSN', resp, controllers[addr]);
        }
        for (let key in controllers) {
          debug('controllers', key, controllers[key]);
        }
      } catch (err) {
        debug('ERROR', err);
      }
    }
    debug('STA', iL.status);
    if (iL.status === 'connected') {
      try {
        resp = await iL.get({ id: id++, request: { addr: 8, cmd: 'get_sn' } });
        debug('GSN', resp, resp.responce.data);
      } catch (err) {
        debug('ERROR', err);
      }
    }
    debug('STA', iL.status);
    if (iL.status === 'connected') {
      try {
        resp = await iL.get({ id: id++, request: { addr: 2, cmd: 'get_time' } });
        debug('GTM', resp, resp.responce.data);
      } catch (err) {
        debug('ERROR', err);
      }
    }
    debug('STA', iL.status);
    if (iL.status === 'connected') {
      try {
        resp = await iL.get({ id: id++, request: { addr: 2, cmd: 'set_time' } });
        debug('STM', resp, resp.responce.data);
      } catch (err) {
        debug('ERROR', err);
      }
    }
    debug('STA', iL.status);
    if (iL.status === 'connected') {
      try {
        resp = await iL.get({ id: id++, request: { addr: 2, cmd: 'get_time' } });
        debug('GTM', resp, resp.responce.data);
      } catch (err) {
        debug('ERROR', err);
      }
    }
    debug('STA', iL.status);
    try {
      resp = await iL.get({ id: id++, request: { addr: null, cmd: 'reset' } });
      debug('RES', resp);
    } catch (err) {
      debug('ERROR', err);
    }
    debug('STA', iL.status);
    if (iL.status === 'disconnected') {
      try {
        resp = await iL.get({ id: id++, request: { addr: null, cmd: 'connect' } });
        debug('CON', resp);
      } catch (err) {
        debug('ERROR', err);
      }
    }
    debug('STA', iL.status);
    if (iL.status === 'connected') {
      try {
        resp = await iL.get({ id: id++, request: { addr: null, cmd: 'disconnect' } });
        debug('DIS', resp);
        addreses = [...resp.responce.data];
      } catch (err) {
        debug('ERROR', err);
      }
    }
  }
  iL1run();
}
function debug(...args) {
  console.log(performance.now().toFixed(0), args);
}

module.exports = ILz397web;