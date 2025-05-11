const username = 'z5rweb';
const statCgi = '/cgi-bin/stat';
const snCgi = '/cgi-bin/sn';
const openCgi = '/cgi-bin/command?DIR=1';

const DEFAULT_TIMEOUT = 2000; // Таймаут ожидания ответа в мс

class ILz5rweb {
  constructor(ip, key) {
    this.ip = ip;
    this.key = key;

    this.authString = `${username}:${key}`;
    this.headers = new Headers()
    this.headers.set('Authorization', 'Basic ' + btoa(this.authString));
  }
  async get(oRequest, timeout = DEFAULT_TIMEOUT) {
    let httpResp;
    let data;
    let resp = { id: oRequest.id, response: { cmd: oRequest.request.cmd, data: null }};
    switch (oRequest.request.cmd) {
      case 'open':
        httpResp = await fetchWithTimeout(`http://${this.ip}${openCgi}`, { method: 'GET', headers: this.headers }, timeout);
        if(httpResp.ok) {
          resp.response.data = 'ok';
          return resp;
        } else throw new Error(`OPEN with ID ${oRequest.id} return status ${httpResp.status}`);
      case 'get_sn':
        httpResp = await fetchWithTimeout(`http://${this.ip}${snCgi}`, { method: 'GET', headers: this.headers }, timeout);
        if(httpResp.ok) {
          data = await httpResp.text();
          resp.response.data = data.replace(/\s+/g, ' ').trim();
          return resp;
        } else throw new Error(`GET_SN with ID ${oRequest.id} return status ${httpResp.status}`);
      case 'get_state':
        let dateTime, uptime;
        httpResp = await fetchWithTimeout(`http://${this.ip}${statCgi}`, { method: 'GET', headers: this.headers }, timeout);
        if(httpResp.ok) {
          data = await httpResp.text();
          const dateTimeMatch = data.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
          if (dateTimeMatch) {
            dateTime = dateTimeMatch[1];
          }
          const uptimeMatch = data.match(/<td[^>]*>Uptime:<\/td>\s*<td[^>]*>(.*?)<\/td>/);
          if (uptimeMatch) {
            uptime = uptimeMatch[1]; // "265 days, 6 hours, 21 minutes"
          }
          resp.response.data = { time: dateTime, uptime: uptime };
          return resp;
        } else throw new Error(`GET_STATE with ID ${oRequest.id} return status ${httpResp.status}`);
      default:
        throw new Error(`Unknown command: ${oRequest.request.cmd}`);
    }
  }
}

async function fetchWithTimeout(url, options = {}, timeout = 5000) {
  const controller = new AbortController();
  const signal = controller.signal;
  options.signal = signal;

  const fetchPromise = fetch(url, options);

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => {
      controller.abort();
      reject(new Error('Request timed out'));
    }, timeout)
  );

  try {
    const response = await Promise.race([fetchPromise, timeoutPromise]);
    return response;
  } catch (error) {
    throw error;
  }
}

module.exports = ILz5rweb;