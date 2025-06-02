const EventEmitter = require('events');
const Net = require('net');

const DEFAULT_TIMEOUT = 10000; // Таймаут ожидания ответа в мс
// const RECONNECT_INTERVAL = 5000; // Интервал между попытками переподключения в мс

// Класс, обмен данными с конвертером ironLogic Z397-web
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
   *      id:           // id запроса от 0 до 255,
   *      request: {
   *        addr:       // адрес контроллера или null,
   *        cmd:        // команда
   *      }
   *    }
   *    Возвращает Promise с объектом вида:
   *    {
   *      id:           // id запроса от 0 до 255,
   *      error:        // ошибка или null,
   *      response: {
   *        addr:       // адрес контроллера или null,
   *        cmd:        // команда указаная в запросе,
   *        data:       // непосредственно ответ или null при ошибке
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
class ILz397web extends EventEmitter {
  constructor(ip, port, key) {
    super();
    this.ip = ip;
    this.port = port;
    this.key = key;

    this.status = 'disconnected';
    this.enabled = false;
    // this._reconnectTimer = null;

    this._buffer = [];
    this._rxState = false;
    this._msgAdvModeOn = Buffer.from([0xff, 0xfa, 0x2c, 0x01, 0x00, 0x03, 0x84, 0x00, 0xff, 0xf0]);
    this._startBytes = [0x1e, 0x20, 0x1f, 0x02]; // обрабатываемые типы пакетов, они же стартовые байты
    this._endByte = 0x0d;

    this._tcpClient = null;
    this._pendingRequests = new Map(); // Map для хранения ожидающих запросов: <id, { resolve, reject, timer }>
  }

  async get(oRequest, timeout = DEFAULT_TIMEOUT) {
    // console.log('[z397web] get ID/cmd:', oRequest.id, oRequest.request.cmd);
    switch (oRequest.request.cmd) {
      case 'connect':
        // this._clearReconnectTimer();
        this.enabled = true;
        return this._handleConnect(oRequest);
      case 'disconnect':
        // this._clearReconnectTimer();
        this.enabled = false;
        return this._handleDisconnect(oRequest);
      case 'reset':
        // this._clearReconnectTimer();
        this.enabled = false;
        return this._handleReset(oRequest, timeout);
      default:
        if (this.status !== 'connected') {
          return Promise.reject(new Error('Not connected'));
        }

        if (oRequest.id < 0x00 || oRequest.id > 0xff) {
          return Promise.reject(new Error('ID is out of range'));
        }

        // Проверка, не занят ли уже этот oRequest.id
        if (this._pendingRequests.has(oRequest.id)) {
          return Promise.reject(new Error(`Packet ID collision for ${oRequest.id}. Try again later.`));
        }

        return new Promise((resolve, reject) => {
          let { addr, cmd } = oRequest.request;
          // Валидация адреса (согласно документации к протоколу)
          addr = addr >= 0x02 && addr <= 0x69 ? addr : null;
          let packetToSend = null;

          // Формирование пакета
          switch (cmd) {
            case 'scan':
              packetToSend = this._makeScanPacket(oRequest.id);
              break;
            case 'get_sn':
              if (addr === null) return reject(new Error('Address required for get_sn'));
              packetToSend = this._makeGetSnPacket(oRequest.id, addr);
              break;
            case 'get_time':
              if (addr === null) return reject(new Error('Address required for get_time'));
              packetToSend = this._makeGetTimePacket(oRequest.id, addr);
              break;
            case 'set_time':
              if (addr === null) return reject(new Error('Address required for set_time'));
              packetToSend = this._makeSetTimePacket(oRequest.id, addr);
              break;
            case 'open':
              if (addr === null) return reject(new Error('Address required for open'));
              packetToSend = this._makeOpenDoorPacket(oRequest.id, addr);
              break;
            default:
              return reject(new Error(`Unknown command: ${cmd}`));
          }

          if (!packetToSend) {
            // Если пакет не был создан (например, из-за ошибки в switch)
            return reject(new Error(`Failed to create packet for command: ${cmd}`));
          }

          // Создаем таймер
          const timer = setTimeout(() => {
            if (this._pendingRequests.has(oRequest.id)) {
              this._pendingRequests.delete(oRequest.id);
              reject(new Error(`Request timed out (id: ${oRequest.id}, cmd: ${cmd})`));
            }
          }, timeout);

          // Сохраняем информацию о запросе
          this._pendingRequests.set(oRequest.id, { resolve, reject, timer, id: oRequest.id, cmd: cmd });

          // Отправляем пакет
          this._send(packetToSend);
        });
    }
  }

  _handleConnect(oRequest) {
    return new Promise((resolve, reject) => {
      if (this.status === 'disconnected') {
        this._init();
        const onInit = (status) => {
          this.off('error', onError);
          resolve({ id: oRequest.id, error: null, response: { addr: null, cmd: 'connect', data: status } });
        };
        const onError = (err) => {
          this.off('init', onInit);
          const errorMsg = err instanceof Error ? err.message : String(err); // !!!!!!!!!!!!!!!!!!!! Проверь генерацию события 'error' в _init
          reject(new Error(`Connect failed: ${errorMsg}`));
        };
        this.once('init', onInit);
        this.once('error', onError);
      } else {
        reject(new Error('Already connected'));
      }
    });
  }

  _handleDisconnect(oRequest) {
    return new Promise((resolve, reject) => {
      if (this.status === 'connected') {
        const onClose = (status) => {
          this.off('error', onError);
          this._tcpClient = null;
          resolve({ id: oRequest.id, error: null, response: { addr: null, cmd: 'disconnect', data: status } });
        };
        const onError = (err) => {
          this.off('close', onClose);
          const errorMsg = err instanceof Error ? err.message : String(err);
          reject(new Error(`Disconnect failed: ${errorMsg}`));
        };
        this.once('close', onClose);
        this.once('error', onError);

        if (this._tcpClient) {
          this._tcpClient.destroy();
        } else {
          onClose('disconnected');
        }
      } else {
        reject(new Error('Already disconnected'));
      }
    });
  }

  _handleReset(oRequest, timeout) {
    return new Promise((resolve, reject) => {
      if (this.status === 'connected') {
        this._tcpClient.destroy();
        this._tcpClient = null;
        this.status = 'disconnected';
      }

      let telnet = new Net.Socket();
      const inTelnet = [];
      let resetCommandSent = false;

      const cleanup = () => {
        if (telnet) {
          telnet.destroy();
          telnet = null;
        }
      };

      telnet.connect(23, this.ip, () => {});

      telnet.on('data', (data) => {
        const dataStr = data.toString();
        inTelnet.push(dataStr);
        // Упрощенная логика - может быть ненадёжной
        if (inTelnet.length === 2 && inTelnet[inTelnet.length - 1] === '> ') {
          telnet.write(`${this.key}\r\n`);
        }
        if (inTelnet.length === 4 && inTelnet[inTelnet.length - 1] === '> ') {
          if (!resetCommandSent) {
            telnet.write('rst\r\n');
            resetCommandSent = true;
            // Не ждем ответа, предполагаем, что команда отправлена
            // Закрываем Telnet соединение
            cleanup();
            // Даем время на перезагрузку
            setTimeout(() => {
              resolve({
                id: oRequest.id,
                error: null,
                response: { addr: null, cmd: 'reset', data: 'initiated' },
              });
            }, 3000);
          }
        }
      });

      telnet.on('error', (err) => {
        cleanup();
        const e = new Error(`Telnet reset failed: ${err.code || err.message}`);
        try{
          this.emit('error', e);
        } catch (e) {
          console.log('[z397web]', 'telnet emit error', e);
        }
        reject(e);
      });

      telnet.on('close', () => {
        // Если соединение закрылось до отправки команды или до резолва - возможно, ошибка
        if (!resetCommandSent) {
          // reject(new Error('Telnet connection closed unexpectedly during reset'));
          // Можно и не реджектить, если закрытие после rst - это норма
        }
        telnet = null; // Убираем ссылку
      });

      // Таймаут для всей операции Telnet
      const telnetTimer = setTimeout(() => {
        cleanup();
        reject(new Error('Telnet reset timed out'));
      }, timeout + 2000); // Даем больше времени на Telnet

      // Сразу после инициирования очищаем таймер, если resolve/reject произошли раньше
      telnet.prependOnceListener('close', () => clearTimeout(telnetTimer)); // Используем prependOnceListener для надежности
      telnet.prependOnceListener('error', () => clearTimeout(telnetTimer));
    });
  }

  // устанавливает подключение и обрабатывает события связаные с подключением
  _init() {
    // Если уже есть активное подключение, ничего не делаем
    if (this._tcpClient && this.status !== 'disconnected') {
      return;
    }

    // this._clearReconnectTimer();

    this.status = 'connecting'; // Устанавливаем статус "подключение"
    console.log(`[z397web] Attempting to connect to ${this.ip}:${this.port}`);

    // Если клиент уже существует, уничтожаем его, чтобы создать новое соединение
    if (this._tcpClient) {
      try { this._tcpClient.destroy(); } catch (e) {};
      this._tcpClient = null;
    }

    this._tcpClient = new Net.Socket();

    // Сброс ожидающих запросов при переподключении
    this._clearPendingRequests(new Error('Connection reset during request'));

    this._tcpClient.connect(this.port, this.ip, () => {
    });

    this._tcpClient.on('connect', () => {
      this.status = 'connected';
      console.log('[z397web] connected');
      this._send(this._msgAdvModeOn); // Отправляем команду включения режима Advanced
      try{
        this.emit('init', this.status); // Сигнал об успешной инициализации
      } catch (e) {
        console.log('[z397web]', 'emit init', e);
      }
    });

    this._tcpClient.on('data', (data) => {
      // Получаем объект { type, id, packet } или null при ошибке разбора/протокола
      let oPacketData = this._receivingData(data); // Получаем {type, id: null, packet}
      
      if (oPacketData && oPacketData.packet && oPacketData.packet.length > 0) {
        // Распаковываем и проверяем контрольную сумму
        let unpacked = this._unpacking(oPacketData); // Получаем {type, id, packet} с ID!
        if (unpacked && unpacked.packet && this._checkSum(unpacked.packet)) {
          this._handlerReceivedData(unpacked); // Передаем {type, id, packet} дальше
        } else if (unpacked && unpacked.packet) {
          try{
            this.emit('error', new Error(`Checksum error (type: ${unpacked.type}, id: ${unpacked.id}) Packet: ${arrToHexStr(unpacked.packet)}`));
          } catch (e) {
            console.log('[z397web]', 'emit error', e);
          }
        }
      } else if (oPacketData && oPacketData.error) {
        // Если _receivingData вернуло ошибку протокола (тип 0x02)
        try{
          this.emit('error', new Error(`Protocol error: ${oPacketData.error}`));
        } catch (e) {
          console.log('[z397web]', 'emit error', e);
        }
      }
    });

    this._tcpClient.on('error', (err) => {
      // this._clearReconnectTimer();

      this.status = 'disconnected'; // Меняем статус при ошибке
      this._clearPendingRequests(new Error(`Socket error: ${err.code}`)); // Отклоняем все ожидающие запросы
      try{
        this.emit('error', new Error(`Socket error: ${err.code || err.message}`)); // Генерируем ошибку
      } catch (e) {
        console.log('[z397web]', 'emit error', e);
      }
      // if (this.enabled) {
      //   console.log(`[z397web] Socket error: ${err.code || err.message}. Attempting reconnect in ${RECONNECT_INTERVAL}ms...`);
      //   this._reconnectTimer = setTimeout(() => {
      //     this._init(); // Повторная попытка инициализации
      //   }, RECONNECT_INTERVAL);
      // }
    });

    this._tcpClient.on('close', (hadError) => {
      const oldStatus = this.status;
      this.status = 'disconnected';

      // this._clearReconnectTimer();

      // Очищаем ожидающие запросы только если закрытие не было инициировано Disconnect
      if (!hadError && oldStatus !== 'disconnected') {
        // Проверяем !hadError чтобы не дублировать reject из 'error'
        this._clearPendingRequests(new Error('Connection closed unexpectedly'));
      }
      try{
        this.emit('close', this.status);
      } catch (e) {
         console.log('[z397web]', 'emit close', e);
      }
      this._tcpClient = null;

      // if (this.enabled) {
      //   console.log(`[z397web] Connection closed (hadError: ${hadError}). Attempting reconnect in ${RECONNECT_INTERVAL}ms...`);
      //   this._reconnectTimer = setTimeout(() => {
      //     this._init(); // Повторная попытка инициализации
      //   }, RECONNECT_INTERVAL);
      // }
    });
  }

  // Сбрасываем setTimeout, реджектим ждущие промисы и точищаем _pendingRequests
  _clearPendingRequests(error) {
    if (this._pendingRequests.size > 0) {
      for (const [id, requestInfo] of this._pendingRequests.entries()) {
        clearTimeout(requestInfo.timer);
        requestInfo.reject(error); // Отклоняем промис
      }
      this._pendingRequests.clear(); // Очищаем Map
    }
  }

  // Сбрасываем таймер переподключения
  // _clearReconnectTimer() {
  //   if (this._reconnectTimer) {
  //     clearTimeout(this._reconnectTimer);
  //     this._reconnectTimer = null;
  //   }
  // }

  _handlerReceivedData(oData) {
    // oData = { type: iType, id: iId, packet: [] }
    const iId = oData.id; // ID из пакета (0-255)

    // Находим соответствующий запрос в _pendingRequests
    const pendingRequest = this._pendingRequests.get(iId);

    if (!pendingRequest) {
      // Ответ на неизвестный ID или запоздавший ответ
      return;
    }

    // Ответ найден, очищаем таймаут
    clearTimeout(pendingRequest.timer);
    this._pendingRequests.delete(iId);

    const iType = oData.type;
    const aPacket = oData.packet;
    let result = { id: pendingRequest.id, error: null, response: { addr: null, cmd: pendingRequest.cmd, data: null } };
    let parseError = null;

    try {
      if (iType === 0x20 && aPacket[0x04] === 0x00 && aPacket[0x05] === 0x00) {
        // scan
        result.response.addr = null; // У Scan нет адреса контроллера в ответе
        result.response.data = this._parseScanResp(aPacket);
      } else if (iType === 0x20 && aPacket[0x04] === 0x00 && aPacket[0x05] >= 0x02) {
        // get_sn
        const snData = this._parseGetSnResp(aPacket);
        if (snData.error) {
          parseError = new Error(snData.error); // Если парсер вернул ошибку
        } else {
          result.response.addr = snData.addr;
          result.response.data = snData.data;
        }
      } else if (iType === 0x1f && aPacket[0x04] === 0x02 && aPacket[0x07] >= 0xd0) {
        // get_time
        const timeData = this._parseGetTime(aPacket);
        if (timeData.error) {
          parseError = new Error(timeData.error); // Если парсер вернул ошибку
        } else {
          result.response.addr = timeData.addr;
          result.response.data = timeData.data;
        }
      } else if (iType === 0x1f && aPacket[0x04] === 0x03 && aPacket[0x08] >= 0x55) {
        // set_time
        const timeSetData = this._parseSetTime(aPacket);
        result.response.addr = timeSetData.addr;
        result.response.data = timeSetData.data;
      } else if (iType === 0x1f && aPacket[0x04] === 0x07 && aPacket[0x08] >= 0x55) {
        // open
        const openData = this._parseOpen(aPacket);
        result.response.addr = openData.addr;
        result.response.data = openData.data;
      } else {
        // Неизвестный тип пакета
        parseError = new Error(`Unknown response structure received (type: ${iType}, cmdByte: ${aPacket[4]})`);
      }
    } catch (e) {
      // Ошибка во время парсинга
      parseError = new Error(`Failed to parse response: ${e.message}`);
    }

    if (parseError) {
      // Если была ошибка парсинга, отклоняем промис
      pendingRequest.reject(parseError);
    } else {
      // console.log('[z397web] Resp ID/cmd:', result.id, result.response.cmd)
      // Если все хорошо, разрешаем промис
      pendingRequest.resolve(result);
    }
  }

  // Методы парсинга возвращают объект с данными или ошибкой

  // парсит пакет с ответом на команду сканирования
  _parseScanResp(data) {
    let scanMask = data.slice(8, data[1]); // Используем data[1] (длину) для надежности
    const addresses = [];
    for (let i = 0; i < scanMask.length; i++) {
      for (let k = 0; k < 8; k++) {
        if (scanMask[i] & (1 << k)) {
          const addr = i * 8 + k + 2;
          addresses.push(addr);
        }
      }
    }
    return addresses; // Просто массив с адресами
  }

  // парсит пакет с ответом на команду запроса серийного номера
  _parseGetSnResp(data) {
    const addr = data[5];
    // Проверка на ошибку "контроллер не найден"
    if (data[5] >> 7 || (data[6] === 0x00 && data[7] === 0x00)) {
      return { addr: addr, data: null, error: 'Controller not found or invalid response' };
    } else {
      const sn = (data[7] << 8) | data[6];
      return { addr: addr, data: sn, error: null };
    }
  }

  // парсит пакет с ответом на команду запроса текущего времени
  _parseGetTime(data) {
    const addr = data[5];
    try {
      let time =
        +new Date(
          parseInt('20' + data[0x0e].toString(16), 10), // Год
          parseInt(data[0x0d].toString(16), 10) - 1, // Месяцы 0-11
          parseInt(data[0x0c].toString(16), 10), // День месяца
          parseInt(data[0x0a].toString(16), 10), // Часы (был 0x0a)
          parseInt(data[0x09].toString(16), 10), // Минуты (был 0x09)
          parseInt(data[0x08].toString(16), 10) // Секунды (был 0x08)
        ) / 1000;
      if (isNaN(time)) {
        return { addr: addr, data: time, error: 'Invalid date components' };
      }
      return { addr: addr, data: time, error: null };
    } catch (e) {
      return { addr: addr, data: null, error: `Time parsing error: ${e.message}` };
    }
  }

  // парсит пакет с ответом на команду установки текущего времени
  _parseSetTime(data) {
    const addr = data[5];
    return { addr: addr, data: 'ok', error: null };
  }

  // парсит пакет с ответом на команду открытия замка
  _parseOpen(data) {
    const addr = data[5];
    return { addr: addr, data: 'ok', error: null };
  }

  // Формирует пакет сканирования шины
  _makeScanPacket(id) {
    const cmdType = 0x20;
    // [...[checksum, length], ...[ license, id, cmd, 0, 0, 0 ] ]
    const packet = [0x08, id, 0x00, 0x00, 0x00, 0x00];
    return Buffer.from(this._assembing(cmdType, packet));
  }

  // Формирует пакет запроса серийного номера
  _makeGetSnPacket(id, addr) {
    let cmdType = 0x20;
    // [...[checksum, length], ...[ license, id, cmd, addr, 0, 0 ] ]
    const packet = [0x08, id, 0x00, addr, 0x00, 0x00];
    return Buffer.from(this._assembing(cmdType, packet));
  }

  // Формирует пакет открытия двери
  _makeOpenDoorPacket(id, addr) {
    const cmdType = 0x1f;
    // [...[checksum, length], ...[license, id, cmd, addr, 0, 0 ] ]
    const packet = [0x08, id, 0x07, addr, 0x00, 0x00];
    return Buffer.from(this._assembing(cmdType, packet));
  }

  // Формирует пакет установки текущего времени контроллера
  _makeSetTimePacket(id, addr) {
    let cmdType = 0x1f;
    // [...[checksum, length], ...[license, id, cmd, addr, bank_number, bank_type, bytes_to_write, MSB, LSB, sec, min, hour, wday, day, mon, year]
    const packet = [0x08, id, 0x03, addr, 0x00, 0xd0, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    let date = new Date();
    // Преобразование в BCD (Binary-Coded Decimal) - каждый полубайт хранит цифру
    const toBcd = (num) => parseInt(num.toString(10), 16);

    packet[0x09] = toBcd(date.getSeconds()); // Секунды BCD
    packet[0x0a] = toBcd(date.getMinutes()); // Минуты BCD
    packet[0x0b] = toBcd(date.getHours()); // Часы BCD
    packet[0x0c] = toBcd(date.getDay() || 7); // День недели (1-Пн, 7-Вс) BCD
    packet[0x0d] = toBcd(date.getDate()); // День месяца BCD
    packet[0x0e] = toBcd(date.getMonth() + 1); // Месяц (1-12) BCD
    packet[0x0f] = toBcd(date.getFullYear() % 100); // Год (00-99) BCD

    return Buffer.from(this._assembing(cmdType, packet));
  }

  // Формирует пакет запроса текущего времени контроллера
  _makeGetTimePacket(id, addr) {
    let cmdType = 0x1f;
    // [...[checksum, length], ...[license, id, cmd, addr, bank_number, bank_type, bytes_to_read, MSB, LSB]
    const packet = [0x08, id, 0x02, addr, 0x00, 0xd0, 0x07, 0x00, 0x00, 0x00];

    return Buffer.from(this._assembing(cmdType, packet));
  }

  // Остальные приватные методы (_send, _receivingData, _checkSum, _assembing, _unpacking, _packing)

  // В _receivingData нужно вернуть и ошибку, если она обнаружена (тип 0x02)
  _receivingData(aData) {
    let rxIndex = this._buffer.length; // Продолжаем добавлять в буфер
    let packet = null; // Используем null как индикатор отсутствия полного пакета
    let cmdType = null;

    // Ищем стартовый байт только если не в середине приема
    if (!this._rxState) {
      const startIndex = aData.findIndex((byte) => this._startBytes.includes(byte));
      if (startIndex !== -1) {
        cmdType = aData[startIndex];
        this._rxState = true;
        this._buffer = [...aData.slice(startIndex)]; // Начинаем буфер со стартового байта
        rxIndex = this._buffer.length;
      } else {
        // Пришли данные без стартового байта и мы его не ждем - игнорируем?
        return null; // Ничего не делаем
      }
    } else {
      // Добавляем новые данные в буфер
      this._buffer.push(...aData);
      rxIndex = this._buffer.length;
    }

    // Ищем байт конца пакета в текущем буфере
    const endIndex = this._buffer.indexOf(this._endByte);
    if (endIndex !== -1) {
      // Пакет получен
      packet = [...this._buffer.slice(0, endIndex + 1)]; // Включая this._endByte
      cmdType = packet[0]; // Тип команды - первый байт пакета

      // Удаляем пакет из буфера
      this._buffer = this._buffer.slice(endIndex + 1);
      this._rxState = false; // Готовы к приему следующего пакета

      // Проверяем на ошибки протокола (тип 0x02)
      if (cmdType === 0x02) {
        let error = 'Unknown protocol error (0x02)';
        const endOfPacket = packet.indexOf(this._endByte);
        const errorCode = '';
        if (endOfPacket !== -1)
          errorCode = packet
            .slice(1, endOfPacket)
            .map((num) => `0x${num.toString(16).padStart(2, '0')}`)
            .join(', ');
        switch (errorCode) {
          case '0x48, 0x48':
            error = 'ERROR CRC';
            break;
          case '0x48, 0x4c, 0x43':
            error = 'ERROR license command';
            break;
          case '0x48, 0x43':
            error = 'ERROR unknown controller';
            break;
          case '0x48, 0x4c, 0x31':
            error = 'ERROR license not active';
            break;
          case '0x48, 0x4c, 0x32':
            error = 'ERROR license is old';
            break;
          case '0x48, 0x4c, 0x33':
            error = 'ERROR too many controllers';
            break;
          case '0x48, 0x4c, 0x34':
            error = 'ERROR read too many cards';
            break;
          case '0x48, 0x4c, 0x35':
            error = 'ERROR write too many cards';
            break;
          case '0x48, 0x4c, 0x36':
            error = 'ERROR write license is old';
            break;
          case '0x48, 0x4a':
            error = 'ERROR packet first byte';
            break;
          default:
            error = `ERROR unknown code 0x${errorCode.toString(16)}`;
            break;
        }
        // Возвращаем ошибку вместо пакета
        return { type: cmdType, id: null, packet: null, error: error };
      } else {
        // Нормальный пакет, удаляем стартовый байт (type) и конечный (0x0d)
        packet.shift(); // Убрать тип
        packet.pop(); // Убрать 0x0d
        return { type: cmdType, id: null, packet: packet, error: null }; // ID будет извлечен в _unpacking
      }
    }
    // Если байт 0x0d не найден, пакет еще не полный
    return null;
  }

  // распаковывает полученый от конвертера пакет, должен вернуть { type, id, packet }
  _unpacking(oData) {
    // oData = { type: cmdType, id: null, packet: packet }
    let iType = oData.type;
    let aPacket = oData.packet; // Пакет без стартового и конечного байтов
    let iId = oData.id; // но ID пока неизвестен

    if (!aPacket || aPacket.length === 0) {
      return { type: iType, id: null, packet: null };
    }

    const temp_in = [0, 0, 0, 0, 0];
    const outPacket = [];
    for (let i = 0; i < aPacket.length; i++) {
      temp_in[i % 5] = aPacket[i];
      if ((i + 1) % 5 === 0) {
        const temp_out = [0, 0, 0, 0];
        for (let k = 0; k < 5; k++) if (temp_in[k] & 0x80) temp_in[k] ^= 0xca;
        for (let k = 0; k < 4; k++) temp_out[k] = temp_in[k] | (((temp_in[4] >> k) & 1) << 7);
        outPacket.push(...temp_out);
      }
    }

    iId = outPacket[3];
    // console.log('[ <= ] Type:', iType.toString(16).padStart(2, '0'), outPacket.map(num => num.toString(16).padStart(2, '0')));
    return { type: iType, id: iId, packet: outPacket };
  }

  // Проверяет контрольную сумму РАСПАКОВАННОГО пакета
  _checkSum(unpackedData) {
    // unpackedData = результат _unpacking
    let packet = [...unpackedData].slice(0, unpackedData[1]);
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

  // Метод _assembing: добавляет длину, ID, считает КС, пакует и обрамляет
  _assembing(iType, dataPayload) {
    // dataPayload - данные БЕЗ длины, ID и КС
    // 1. Формируем пакет с KC, длиной и данными
    let packet = [0x00, 0x00, ...dataPayload]; // Место для KC, длины и данные
    packet[1] = packet.length;

    // 2. Считаем КС
    let sum = 0;
    for (let i = 0; i < packet.length; i++) sum += packet[i];
    packet[0] = 0xff - (sum & 0xff);

    // 3. Паддинг до кратной 4 байтам длины
    while (packet.length % 4 != 0) packet.push(0);

    // console.log('[ => ] Type:', iType.toString(16).padStart(2, '0'), packet.map(num => num.toString(16).padStart(2, '0')));
    // 4. Упаковываем (_packing)
    let packedData = this._packing(packet);

    // 5. Добавляем стартовый байт (тип) и конечный байт (0x0d)
    let finalPacket = [iType, ...packedData, 0x0d];

    return finalPacket;
  }

  _packing(notPackedData) {
    // notPackedData - пакет с длиной, id, данными, КС и паддингом
    const temp_in = [0, 0, 0, 0];
    let outPacket = [];
    for (let i = 0; i < notPackedData.length; i++) {
      temp_in[i % 4] = notPackedData[i];
      if ((i + 1) % 4 === 0) {
        const temp_out = [0, 0, 0, 0, 0];
        temp_out[0] =
          ((temp_in[0] & 0x80) >> 4) +
          ((temp_in[1] & 0x80) >> 5) +
          ((temp_in[2] & 0x80) >> 6) +
          ((temp_in[3] & 0x80) >> 7);
        for (let k = 0; k < 4; k++) temp_out[k + 1] = temp_in[k] & 0x7f;
        for (let k = 0; k < 5; k++) if (temp_out[k] < 48) temp_out[k] ^= 0xca;
        outPacket.push(...temp_out);
      }
    }
    return outPacket;
  }

  _send(data) {
    if (this.status === 'connected' && this._tcpClient) {
      this._tcpClient.write(Buffer.from(data)); // Отправляем как Buffer
    } else {
      return;
    }
  }
} // Конец класса

function arrToHexStr(numbers) {
    if (!numbers.every(num => num >= 0 && num <= 255)) {
        throw new Error('[arrToHexStr] Все числа должны быть в диапазоне от 0 до 255');
    }
    const hexArray = numbers.map(num => {
        const hex = num.toString(16).padStart(2, '0');
        return `0x${hex}`;
    });
    return hexArray.join(' ');
}

module.exports = ILz397web;