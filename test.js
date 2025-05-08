const { ILz397web, ILz5rweb } = require('./index.js');

const DEBUG = 'z5rweb';

const IP = '192.168.14.9';
const PORT = 1000;
const KEY = '2B07D1B1';

if (DEBUG === 'z397web') {
  const iL = new ILz397web(IP, PORT, KEY);
  // const iL = new ILz397web('192.168.1.115', 1000, '8C0552F2');

  let id = 0;
  async function iL1run() {
    let resp;
    let addreses = [];
    const controllers = new Map();
    debug('STA_01', iL.status);
    if (iL.status === 'disconnected') {
      try {
        resp = await iL.get({ id: id++, request: { addr: null, cmd: 'connect' } });
        debug('CON', resp);
      } catch (err) {
        debug('ERROR', err.message);
      }
    }
    debug('STA_02', iL.status);
    if (iL.status === 'connected') {
      try {
        resp = await iL.get({ id: id++, request: { addr: null, cmd: 'scan' } });
        addreses = [...resp.responce.data];
        debug('SCN', resp);
      } catch (err) {
        debug('ERROR', err.message);
      }
    }
    debug('STA_03', iL.status);
    if (iL.status === 'connected') {
      try {
        for (addr of addreses) {
          resp = await iL.get({ id: id++, request: { addr: addr, cmd: 'get_sn' } });
          controllers.set(addr, { sn: resp.responce.data });
          debug('GSN', resp);
        }
        for (let key in controllers) {
          debug('controllers', key, controllers.get(key));
        }
      } catch (err) {
        debug('ERROR', err.message);
      }
    }
    debug('STA_04', iL.status);
    if (iL.status === 'connected') {
      try {
        resp = await iL.get({ id: id++, request: { addr: 8, cmd: 'get_sn' } });
        debug('GSN', resp);
      } catch (err) {
        debug('ERROR', err.message);
      }
    }
    debug('STA_05', iL.status);
    if (iL.status === 'connected') {
      try {
        resp = await iL.get({ id: id++, request: { addr: 2, cmd: 'get_time' } });
        debug('GTM', resp);
      } catch (err) {
        debug('ERROR', err.message);
      }
    }
    debug('STA_06', iL.status);
    if (iL.status === 'connected') {
      try {
        resp = await iL.get({ id: id++, request: { addr: 2, cmd: 'set_time' } });
        debug('STM', resp);
      } catch (err) {
        debug('ERROR', err.message);
      }
    }
    debug('STA_07', iL.status);
    if (iL.status === 'connected') {
      try {
        resp = await iL.get({ id: id++, request: { addr: 2, cmd: 'get_time' } });
        debug('GTM', resp);
      } catch (err) {
        debug('ERROR', err.message);
      }
    }
    debug('STA_08', iL.status);
    try {
      resp = await iL.get({ id: id++, request: { addr: null, cmd: 'reset' } });
      debug('RES', resp);
    } catch (err) {
      debug('ERROR', err.message);
    }
    debug('STA_09', iL.status);
    if (iL.status === 'disconnected') {
      try {
        resp = await iL.get({ id: id++, request: { addr: null, cmd: 'connect' } });
        debug('CON', resp);
      } catch (err) {
        debug('ERROR', err.message);
      }
    }
    debug('STA_10', iL.status);
    if (iL.status === 'connected') {
      try {
        resp = await iL.get({ id: id++, request: { addr: null, cmd: 'disconnect' } });
        debug('DIS', resp);
      } catch (err) {
        debug('ERROR', err.message);
      }
    }
  }

  iL.on('error', (err) => {
    debug('>>> Global Error Event:', err.message); // Ловим ошибки сокета или протокола
  });
  iL.on('close', (status) => {
    debug('>>> Global Close Event:', status);
  });

  iL1run();
}

function debug(...args) {
  console.log(performance.now().toFixed(0), '\t\t', ...args);
}

if (DEBUG === 'z5rweb') {
  const iL = new ILz5rweb('192.168.14.1', '0ACA3EEE', 3000);

  let id = 0;
  async function iL1run() {
    let resp;
    try {
      resp = await iL.get({ id: id++, request: { cmd: 'open' } }, 1000);
      console.log('OPEN', resp);
    } catch (err) {
      console.log('ERROR', err.message);
    }
    try {
      resp = await iL.get({ id: id++, request: { cmd: 'get_sn' } });
      console.log('GET SN', resp);
    } catch (err) {
      console.log('ERROR', err.message);
    }
    try {
      resp = await iL.get({ id: id++, request: { cmd: 'get_state' } });
      console.log('GET SN', resp);
    } catch (err) {
      console.log('ERROR', err.message);
    }
  }

  iL1run();
}
