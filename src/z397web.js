const EventEmitter = require('events');
const Net = require('net');

const DEBUG = 'demo';
const DEFAULT_TIMEOUT = 2000; // Таймаут ожидания ответа в мс

// Класс, обмен данными с конвертером ironLogic Z397-web
class ILz397web extends EventEmitter {
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
    this._startBytes = [0x1e, 0x20, 0x1f, 0x02]; // обрабатываемые типы пакетов, они же стартовые байты
    this._endByte = 0x0d;

    this._tcpClient = null;
    this._pendingRequests = new Map(); // Map для хранения ожидающих запросов: <id, { resolve, reject, timer }>
  }

  async get(oRequest, timeout = DEFAULT_TIMEOUT) {
    if (DEBUG === 'messages' || DEBUG === 'demo') debug('FN - get', oRequest);

    if (oRequest.request.cmd === 'connect') {
      return new Promise((resolve, reject) => {
        if (this.status === 'disconnected') {
          this._init();
          const onInit = (status) => {
            this.off('error', onError);
            this.enabled = true;
            resolve({ id: oRequest.id, error: null, responce: { addr: null, cmd: 'connect', data: status } });
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

    if (oRequest.request.cmd === 'disconnect') {
      return new Promise((resolve, reject) => {
        if (this.status === 'connected') {
          const onClose = (status) => {
            this.off('error', onError);
            this.enabled = false;
            this._tcpClient = null;
            resolve({ id: oRequest.id, error: null, responce: { addr: null, cmd: 'disconnect', data: status } });
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

    if (oRequest.request.cmd === 'reset') {
      return new Promise((resolve, reject) => {
        if (!this._tcpClient) {
          return reject(new Error('Cannot reset when not connected via main protocol'));
        }
        // Сохраняем текущий статус, т.к. сокет будет уничтожен !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
        // const wasConnected = this.status === 'connected';
        // if(wasConnected) {

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
                  responce: { addr: null, cmd: 'reset', data: 'reset initiated' },
                });
              }, 3000);
            }
          }
        });

        telnet.on('error', (err) => {
          cleanup();
          reject(new Error(`Telnet reset failed: ${err.code || err.message}`));
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

  // устанавливает подключение и обрабатывает события связаные с подключением
  _init() {
    if (DEBUG === 'messages' || DEBUG === 'demo') debug('FN - _init');

    if (this._tcpClient) {
      try {
        this._tcpClient.destroy();
      } catch (e) {
        /* ignore */
      }
    }
    this._tcpClient = new Net.Socket();
    // Сброс ожидающих запросов при переподключении
    this._clearPendingRequests(new Error('Connection reset during request'));

    this._tcpClient.connect(this.port, this.ip, () => {
      this.status = 'connecting';
    });

    this._tcpClient.on('connect', () => {
      this.status = 'connected';
      this._send(this._msgAdvModeOn); // Отправляем команду включения режима Advanced
      this.emit('init', this.status); // Сигнал об успешной инициализации
    });

    this._tcpClient.on('data', (data) => {
      if (DEBUG === 'messages') debug('RAW DATA IN:', data);
      // Получаем объект { type, id, packet } или null при ошибке разбора/протокола
      let oPacketData = this._receivingData(data); // Получаем {type, id: null, packet}

      if (oPacketData && oPacketData.packet && oPacketData.packet.length > 0) {
        // Распаковываем и проверяем контрольную сумму
        let unpacked = this._unpacking(oPacketData); // Получаем {type, id, packet} с ID!
        if (DEBUG === 'messages') debug('UNPACKED:', unpacked);
        if (unpacked && unpacked.packet && this._checkSum(unpacked.packet)) {
          this._handlerReceivedData(unpacked); // Передаем {type, id, packet} дальше
        } else if (unpacked && unpacked.packet) {
          debug('CHECKSUM ERROR', unpacked.packet);
          this.emit(
            'error',
            new Error(`Checksum error for incoming packet (type: ${unpacked.type}, id: ${unpacked.id})`)
          );
        }
      } else if (oPacketData && oPacketData.error) {
        // Если _receivingData вернуло ошибку протокола (тип 0x02)
        debug('PROTOCOL ERROR:', oPacketData.error);
        this.emit('error', new Error(`Protocol error: ${oPacketData.error}`));
      }
    });

    this._tcpClient.on('error', (err) => {
      debug('SOCKET ERROR:', err.code);
      this.status = 'disconnected'; // Меняем статус при ошибке
      this._clearPendingRequests(new Error(`Socket error: ${err.code}`)); // Отклоняем все ожидающие запросы
      this.emit('error', new Error(`Socket error: ${err.code || err.message}`)); // Генерируем ошибку
    });

    this._tcpClient.on('close', (hadError) => {
      debug('SOCKET CLOSE:', hadError ? 'due to error' : 'normally');
      const oldStatus = this.status;
      this.status = 'disconnected';
      // Очищаем ожидающие запросы только если закрытие не было инициировано Disconnect
      if (!hadError && oldStatus !== 'disconnected') {
        // Проверяем !hadError чтобы не дублировать reject из 'error'
        this._clearPendingRequests(new Error('Connection closed unexpectedly'));
      }
      this.emit('close', this.status);
      this._tcpClient = null;
    });
  }

  // Сбрасываем setTimeout, реджектим ждущие промисы и точищаем _pendingRequests
  _clearPendingRequests(error) {
    if (this._pendingRequests.size > 0) {
      debug(`Clearing ${this._pendingRequests.size} pending requests due to: ${error.message}`);
      for (const [id, requestInfo] of this._pendingRequests.entries()) {
        clearTimeout(requestInfo.timer);
        requestInfo.reject(error); // Отклоняем промис
      }
      this._pendingRequests.clear(); // Очищаем Map
    }
  }

  _handlerReceivedData(oData) {
    // oData = { type: iType, id: iId, packet: [] }
    if (DEBUG === 'messages' || DEBUG === 'demo') debug('FN - _handlerReceivedData');

    const iId = oData.id; // ID из пакета (0-255)

    // Находим соответствующий запрос в _pendingRequests
    const pendingRequest = this._pendingRequests.get(iId);

    if (!pendingRequest) {
      // Ответ на неизвестный ID или запоздавший ответ
      debug(`Received data for unknown or timed out request (id: ${iId})`, oData.packet);
      return;
    }

    // Ответ найден, очищаем таймаут
    clearTimeout(pendingRequest.timer);
    this._pendingRequests.delete(iId);

    const iType = oData.type;
    const aPacket = oData.packet;
    let result = { id: pendingRequest.id, error: null, responce: { addr: null, cmd: pendingRequest.cmd, data: null } };
    let parseError = null;

    try {
      // --- Используем более надежный способ определения типа ответа ---
      // (Пример: можно создать ключ на основе типа и команды/подтипа)
      const responseKey = `${iType}-${aPacket[4]}-${aPacket[5]}`; // Пример ключа, нужно адаптировать под реальные различия

      if (iType === 0x20 && aPacket[0x04] === 0x00 && aPacket[0x05] === 0x00) {  // scan
        result.responce.addr = null; // У Scan нет адреса контроллера в ответе
        result.responce.data = this._parseScanResp(aPacket);
      } else if (iType === 0x20 && aPacket[0x04] === 0x00 && aPacket[0x05] >= 0x02) { // get_sn
        const snData = this._parseGetSnResp(aPacket);
        if (snData.error) {
          parseError = new Error(snData.error); // Если парсер вернул ошибку
        } else {
          result.responce.addr = snData.addr;
          result.responce.data = snData.data;
        }
      } else if (iType === 0x1f && aPacket[0x04] === 0x02 && aPacket[0x07] >= 0xd0) { // get_time
        const timeData = this._parseGetTime(aPacket);
        if (timeData.error) {
          parseError = new Error(snData.error); // Если парсер вернул ошибку
        } else {
          result.responce.addr = timeData.addr;
          result.responce.data = timeData.data;
        }
      } else if (iType === 0x1f && aPacket[0x04] === 0x03 && aPacket[0x08] >= 0x55) { // set_time
        const timeSetData = this._parseSetTime(aPacket);
        result.responce.addr = timeSetData.addr;
        result.responce.data = timeSetData.data;
      } else if (iType === 0x1f && aPacket[0x04] === 0x07 && aPacket[0x08] >= 0x55) { // open
        const openData = this._parseOpen(aPacket);
        result.responce.addr = openData.addr;
        result.responce.data = openData.data;
      } else {  // Неизвестный тип пакета
        if (DEBUG) debug('Unknown packet structure in _handlerReceivedData', aPacket);
        parseError = new Error(`Unknown response structure received (type: ${iType}, cmdByte: ${aPacket[4]})`);
      }
    } catch (e) { // Ошибка во время парсинга
      debug('Error during parsing response:', e);
      parseError = new Error(`Failed to parse response: ${e.message}`);
    }

    if (parseError) { // Если была ошибка парсинга, отклоняем промис
      pendingRequest.reject(parseError);
    } else { // Если все хорошо, разрешаем промис
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

    if (DEBUG === 'messages' || DEBUG === 'demo') debug('FN - _parseScanResp', addresses);

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

      if (DEBUG === 'messages' || DEBUG === 'demo') debug('FN - _parseGetSnResp', addr, sn);

      return { addr: addr, data: sn, error: null };
    }
  }

  // парсит пакет с ответом на команду запроса текущего времени
  _parseGetTime(data) {
    const addr = data[5];
    try {
      let time = +new Date(
        parseInt('20' + data[0x0e].toString(16), 10), // Год
        parseInt(data[0x0d].toString(16), 10) - 1, // Месяцы 0-11
        parseInt(data[0x0c].toString(16), 10), // День месяца
        parseInt(data[0x0a].toString(16), 10), // Часы (был 0x0a)
        parseInt(data[0x09].toString(16), 10), // Минуты (был 0x09)
        parseInt(data[0x08].toString(16), 10) // Секунды (был 0x08)
      );
      if (isNaN(time)) {
        return { addr: addr, data: time, error: 'Invalid date components' };
      }

      if (DEBUG === 'messages' || DEBUG === 'demo') debug('FN - _parseGetTime', addr, time);

      return { addr: addr, data: time, error: null };
    } catch (e) {
      debug('Error parsing time data:', data);
      return { addr: addr, data: null, error: `Time parsing error: ${e.message}` };
    }
  }

  // парсит пакет с ответом на команду установки текущего времени
  _parseSetTime(data) {
    if (DEBUG === 'messages' || DEBUG === 'demo') debug('FN - _parseSetTime');

    const addr = data[5];
    return { addr: addr, data: 'ok', error: null };
  }

  // парсит пакет с ответом на команду открытия замка
  _parseOpen(data) {
    if (DEBUG === 'messages' || DEBUG === 'demo') debug('FN - _parseOpen');

    const addr = data[5];
    return { addr: addr, data: 'ok', error: null };
  }

  // Формирует пакет сканирования шины
  _makeScanPacket(id) {
    if (DEBUG === 'messages' || DEBUG === 'demo') debug('FN - _makeScanPacket');

    const cmdType = 0x20;
    // [...[checksum, length], ...[ license, id, cmd, 0, 0, 0 ] ]
    const packet = [0x08, id, 0x00, 0x00, 0x00, 0x00];
    return Buffer.from(this._assembing(cmdType, packet));
  }

  // Формирует пакет запроса серийного номера
  _makeGetSnPacket(id, addr) {
    if (DEBUG === 'messages' || DEBUG === 'demo') debug('FN - _makeGetSnPacket', addr);

    let cmdType = 0x20;
    // [...[checksum, length], ...[ license, id, cmd, addr, 0, 0 ] ]
    const packet = [0x08, id, 0x00, addr, 0x00, 0x00];
    return Buffer.from(this._assembing(cmdType, packet));
  }

  // Формирует пакет открытия двери
  _makeOpenDoorPacket(id, addr) {
    if (DEBUG === 'messages' || DEBUG === 'demo') debug('FN - _makeOpenDoorPacket', addr);

    const cmdType = 0x1f;
    // [...[checksum, length], ...[license, id, cmd, addr, 0, 0 ] ]
    const packet = [0x08, id, 0x07, addr, 0x00, 0x00];
    return Buffer.from(this._assembing(cmdType, packet));
  }

  // Формирует пакет установки текущего времени контроллера
  _makeSetTimePacket(id, addr) {
    if (DEBUG === 'messages' || DEBUG === 'demo') debug('FN - _makeSetTimePacket', addr);

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
    if (DEBUG === 'messages' || DEBUG === 'demo') debug('FN - _makeGetTimePacket', addr);

    let cmdType = 0x1f;
    // [...[checksum, length], ...[license, id, cmd, addr, bank_number, bank_type, bytes_to_read, MSB, LSB]
    const packet = [0x08, id, 0x02, addr, 0x00, 0xd0, 0x07, 0x00, 0x00, 0x00];

    return Buffer.from(this._assembing(cmdType, packet));
  }

  // Остальные приватные методы (_send, _receivingData, _checkSum, _assembing, _unpacking, _packing)
  // В _receivingData нужно вернуть и ошибку, если она обнаружена (тип 0x02)
  _receivingData(aData) {
    if (DEBUG === 'messages' || DEBUG === 'demo') debug('FN - _receivingData'/*, aData*/);

    let rxIndex = this._buffer.length; // Продолжаем добавлять в буфер
    let packet = null; // Используем null как индикатор отсутствия полного пакета
    let cmdType = null;
    let errorResult = null; // Для ошибок протокола

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
        debug('Received data without start byte:', aData);
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
        const endOfPacket = array.indexOf(this._endByte);
        const errorCode = '';
        if (endOfPacket !== -1) errorCode = ((packet.slice(1, endOfPacket)).map(num => `0x${num.toString(16)}`)).join(', ');
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
            error = `ERROR unknown code 0x${errorCode1.toString(16)}`;
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
    if (DEBUG === 'messages' || DEBUG === 'demo') debug('FN - _unpacking');

    let iType = oData.type;
    let aPacket = oData.packet; // Пакет без стартового и конечного байтов
    let iId = oData.id; // но ID пока неизвестен

    if (!aPacket || aPacket.length === 0) {
      debug('Warning: _unpacking received empty packet');
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
    return { type: iType, id: iId, packet: outPacket };
  }

  // Проверяет контрольную сумму РАСПАКОВАННОГО пакета
  _checkSum(unpackedData) {
    // unpackedData = результат _unpacking
    if (DEBUG === 'messages' || DEBUG === 'demo') debug('FN - _checkSum');

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
    if (DEBUG === 'messages' || DEBUG === 'demo') debug('FN - _assembing');

    // 1. Формируем пакет с KC, длиной и данными
    let packet = [0x00, 0x00, ...dataPayload]; // Место для KC, длины и данные
    packet[1] = packet.length;

    // 2. Считаем КС
    let sum = 0;
    for (var i = 0; i < packet.length; i++) sum += packet[i];
    packet[0] = 0xff - (sum & 0xff);

    // 3. Паддинг до кратной 4 байтам длины
    while (packet.length % 4 != 0) packet.push(0);

    // 4. Упаковываем (_packing)
    let packedData = this._packing(packet);

    // 5. Добавляем стартовый байт (тип) и конечный байт (0x0d)
    let finalPacket = [iType, ...packedData, 0x0d];

    return finalPacket;
  }

  _packing(notPackedData) {
    // notPackedData - пакет с длиной, id, данными, КС и паддингом
    if (DEBUG === 'messages' || DEBUG === 'demo') debug('FN - _packing');

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
    if (DEBUG === 'messages' || DEBUG === 'demo') debug('FN - _send');

    if (this.status === 'connected' && this._tcpClient) {
      this._tcpClient.write(Buffer.from(data)); // Отправляем как Buffer
    } else {
      // Не генерируем ошибку здесь, т.к. проверка статуса есть в get()
      debug('Attempted to send while not connected');
      // Важно: Если отправка не удалась, нужно отменить соответствующий промис
      // Но как найти промис без ID? Это проблема. Проверка в get() должна быть основной.
    }
  }
} // Конец класса

function debug(...args) {
  console.log(performance.now().toFixed(0), '\t\t', ...args);
}


if (DEBUG === 'demo') {
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
  
  iL.on('error', (err) => {
    debug('>>> Global Error Event:', err); // Ловим ошибки сокета или протокола
  });
  iL.on('close', (status) => {
    debug('>>> Global Close Event:', status);
  });

  iL1run();
}






/*

// --- Демо блок ---
if (DEBUG === 'demo') {
  const iL = new ILz397web('192.168.14.9', 1000, '2B07D1B1');
  // const iL = new ILz397web('192.168.1.115', 1000, '8C0552F2');

  let requestIdCounter = 1; // Используем счетчик для уникальных ID запросов

  async function runDemo() {
    debug('DEMO START');
    try {
      // Подключение
      debug('Connecting...');
      let resp = await iL.get({ id: requestIdCounter++, request: { cmd: 'connect' } });
      debug('CONNECT Resp:', resp);

      // --- Тест одновременных запросов ---
      debug('Sending concurrent requests...');
      const promises = [];
      promises.push(
        iL
          .get({ id: requestIdCounter++, request: { cmd: 'scan' } })
          .then((r) => debug('SCAN Resp:', r))
          .catch((e) => debug('SCAN Error:', e))
      );
      promises.push(
        iL
          .get({ id: requestIdCounter++, request: { addr: 2, cmd: 'get_sn' } })
          .then((r) => debug('GET_SN (2) Resp:', r))
          .catch((e) => debug('GET_SN (2) Error:', e))
      );
      promises.push(
        iL
          .get({ id: requestIdCounter++, request: { addr: 8, cmd: 'get_sn' } })
          .then((r) => debug('GET_SN (8) Resp:', r))
          .catch((e) => debug('GET_SN (8) Error:', e))
      );
      promises.push(
        iL
          .get({ id: requestIdCounter++, request: { addr: 2, cmd: 'get_time' } })
          .then((r) => debug('GET_TIME (2) Resp:', r))
          .catch((e) => debug('GET_TIME (2) Error:', e))
      );

      await Promise.allSettled(promises); // Ждем завершения всех
      debug('Concurrent requests finished.');
      // ------------------------------------

      // Последовательные запросы
      debug('Sending sequential requests...');
      resp = await iL.get({ id: requestIdCounter++, request: { addr: 2, cmd: 'set_time' } });
      debug('SET_TIME (2) Resp:', resp);

      await new Promise((resolve) => setTimeout(resolve, 100)); // Небольшая пауза

      resp = await iL.get({ id: requestIdCounter++, request: { addr: 2, cmd: 'get_time' } });
      debug('GET_TIME (2) after set Resp:', resp);

      //await new Promise((resolve) => setTimeout(resolve, 100));

      //resp = await iL.get({ id: requestIdCounter++, request: { addr: 2, cmd: 'open' } });
      //debug('OPEN (2) Resp:', resp);

      // Тест таймаута (пример - запрос к несуществующему адресу, который может не ответить)
      // debug('Testing timeout...');
      // try {
      //      await iL.get({ id: requestIdCounter++, request: { addr: 99, cmd: 'get_sn' } }, 2000); // Таймаут 2 сек
      // } catch (e) {
      //      debug('TIMEOUT/Error Test Result:', e.message); // Ожидаем ошибку таймаута или "Controller not found"
      // }

      // Отключение
      debug('Disconnecting...');
      resp = await iL.get({ id: requestIdCounter++, request: { cmd: 'disconnect' } });
      debug('DISCONNECT Resp:', resp);
    } catch (error) {
      debug('DEMO sequence error:', error);
    } finally {
      debug('DEMO END');
      // Убедимся, что соединение закрыто, если что-то пошло не так
      if (iL.status !== 'disconnected' && iL._tcpClient) {
        iL._tcpClient.destroy();
      }
    }
  }

  iL.on('error', (err) => {
    debug('>>> Global Error Event:', err); // Ловим ошибки сокета или протокола
  });
  iL.on('close', (status) => {
    debug('>>> Global Close Event:', status);
  });

  runDemo();
}
*/
module.exports = ILz397web;
