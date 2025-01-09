require('dotenv').config();
const express = require('express');
const fs = require('fs');
const axios = require('axios');

const start = getTimestamp();
const uiEnabled = (process.env.UI_ENABLED || 'no') === 'no' ? false : true;
const uiPort = parseInt(process.env.PORT || 7675);
const uiUrl = process.env.UI_URL || `http://${process.env.UI_HOST_IP}:${uiPort}`;
const uiTheme = (process.env.UI_THEME || 'light') === 'light' ? true : false;
const logEnabled = (process.env.LOG_ENABLED || 'no') === 'no' ? false : true;
const logFile = `${process.env.LOG_DIRECTORY || ''}porkbun-dynamic-dns.log`;
const interval = parseInt(process.env.UPDATE_INTERVAL || 300) * 1000;
const apiKey = (process.env.PORKBUN_API_KEY || '') === '' ? undefined : process.env.PORKBUN_API_KEY;
const secKey = (process.env.PORKBUN_SECRET_KEY || '') === '' ? undefined : process.env.PORKBUN_SECRET_KEY;
const domain = (process.env.DOMAIN_NAME || '') === '' ? undefined : process.env.DOMAIN_NAME;

const recordType = 'A';
const records = [];
const subdomains = (process.env.SUBDOMAINS_TO_UPDATE || '').split(',');
if ((process.env.UPDATE_WILDCARD_DOMAIN || 'no') === 'yes') subdomains.unshift('*');
if ((process.env.UPDATE_ROOT_DOMAIN || 'no') === 'yes') subdomains.unshift('ROOTDOMAIN');
subdomains.forEach((subdomain) => { 
  subdomain = subdomain.trim();
  if (subdomain.length > 0) {
    records.push({
      name: (subdomain === 'ROOTDOMAIN') ? domain : subdomain + '.' + domain,
      endpoint: `https://api.porkbun.com/api/json/v3/dns/editByNameType/${domain}/${recordType}/${subdomain === 'ROOTDOMAIN' ? '' : subdomain}`,
      status: 'unknown',
      updated: 'unknown',
      ip: 'unknown',
      id: 'unknown'
    }); 
  }
});

let status = 'RUNNING';
let lastIpCheck = '-';
let nextIpCheck = '-';
let lastIpFound = '-';
let lastIpChangeTimestamp = '-';
let ipChangeCount = 0;

if (uiEnabled) {
  const server = express();
  const cssDark = `body { font-family: arial, sans-serif; color: #cccccc; background-color: #111111 }tr:nth-child(even) { background-color: #222222; }td, th { border: 1px solid #555555; text-align: left; padding: 8px; }table { font-family: arial, sans-serif; border-collapse: collapse; width: 100%; }button { color: #dddddd; background-color: #333333; }`
  const cssLight = `body { font-family: arial, sans-serif; }tr:nth-child(even) { background-color: #dddddd; }td, th { border: 1px solid #dddddd; text-align: left; padding: 8px; }table { font-family: arial, sans-serif; border-collapse: collapse; width: 100%; }`

  server.listen(uiPort, () => {
    console.log(`UI is accessible at ${uiUrl}`);
  });

  server.get('/', (req, res) => {
    res.set('Content-Type', 'text/html');
    res.send(`
      <!DOCTYPE html><html><head><style>${uiTheme ? cssLight : cssDark}</style></head><body>
      <h3>Porkbun Dynamic DNS Updater</h3>
      <p>Status: <b>${status}</b></p>
      ${generateStatusTable()}<br/>
      ${generateRecordStatusTable()}<br/>
      <button type="submit" onclick="location.href='${uiUrl}/pause'">Pause / Resume</button>
      <button type="submit" onclick="location.href='${uiUrl}/'">Refresh Page</button><br/><br/>
      Server started at ${start}<br/>Page updated at ${getTimestamp()}
      </body></html>
    `);
  });

  server.get('/pause', (req, res) => {
    status = status === 'RUNNING' ? 'PAUSED' : 'RUNNING';
    res.redirect('/');
  });

  function generateStatusTable() {
    const lastChange = lastIpChangeTimestamp === '-' ? '' : `<tr><td>Last IP Change</td><td>${lastIpChangeTimestamp}</td></tr>`
    return `
      <table>
        <tr><td>Last IP Check</td><td>${lastIpCheck}</td></tr>
        <tr><td>Last IP Found</td><td>${lastIpFound}</td></tr>
        <tr><td>Next IP Check</td><td>${status === 'RUNNING' ? nextIpCheck : '-'}</td></tr>
        <tr><td>Number of IP Changes</td><td>${ipChangeCount}</td></tr>${lastChange}
      </table>`;
  }
  
  function generateRecordStatusTable() {
    const header = `<tr><th>DNS Record</th><th>IP Value</th><th>Last Update Status</th><th>Last Successful Update/Retrieval</th></tr>`;
    let rows = '';
    records.forEach(record => {
      rows += `<tr><td>${record.name}</td><td>${record.ip}</td><td>${record.status}</td><td>${record.updated}</td></tr>`
    });
    return `<table>${header}${rows}</table>`;
  }
}

const scheduledUpdater = async () => {
  if (status === 'RUNNING') {
    lastIpCheck = getTimestamp();
    const ip = await getPublicIp();
    if (ip && lastIpFound !== ip) {
      if (lastIpFound !== '-') {
        log(`New public IP found [${ip}] previous IP [${lastIpFound}]`, 'NEW_IP');
        lastIpChangeTimestamp = getTimestamp();
        ipChangeCount++;
      }
      lastIpFound = ip;
    }
    updateDNSRecords(ip);
  }  
  nextIpCheck = getTimestamp(interval);
  setTimeout(scheduledUpdater, interval);
}

async function getPublicIp() {
  try {
    const res = await axios.get('https://api.ipify.org');
    if (res && res.data && /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(res.data)) {
      return res.data;
    } else {
      log('Error: recieved an invalid IP', 'ERROR');
    }
  } catch (error) {
    log(`Error response from api.ipify.org [${error.response.status}]`, 'ERROR');
  }
  return undefined;
}

async function updateDnsRecord(index, ip) {
  if (records[index].ip === ip) {
    records[index].status = 'SKIPPED_UPDATE_NO_IP_CHANGE';
    return;
  } 
  try {
    const res = await axios.post(records[index].endpoint, {
      "secretapikey": secKey,
      "apikey": apiKey,
      "content": ip,
      "ttl": "600"
    });
    records[index].updated = getTimestamp();
    records[index].ip = ip;
    records[index].status = 'UPDATED';
  } catch (error) {
    if (error.response && error.response.data && error.response.data.message) {
      log(`Error response from porkbun api [${error.response.data.message}]`, 'ERROR');
    } else {
      log(`Error response from porkbun api`, 'ERROR');
      console.log(error);
    }
    records[index].status = 'UPDATE_ERROR';
  }
}

async function updateDNSRecords(ip) {
  if (!ip) {
    records.forEach((record, index, arr) => arr[index].status = 'SKIPPED_DUE_TO_INVALID_IP_RESPONSE');
    return;
  }
  const queueLength = 2000; // 2s delay between requests to porkbun API
  for (let i = 0; i < records.length; i++) {
    setTimeout(async () => await updateDnsRecord(i, ip), queueLength * i);
  }
}

const retrieveCurrentRecords = async () => {
  try {
    const endpoint = `https://api.porkbun.com/api/json/v3/dns/retrieve/${domain}`;
    const res = await axios.post(endpoint, {"secretapikey": secKey, "apikey": apiKey});
    res.data.records
      .filter(record => record.type === 'A')
      .forEach(liveRecord => {
        records.forEach((localRecord, index, arr) => {
          if (localRecord.name === liveRecord.name) {
            arr[index].id = liveRecord.id;
            arr[index].ip = liveRecord.content;
            arr[index].ttl = liveRecord.ttl;
            arr[index].updated = getTimestamp();
            arr[index].status = 'RETRIEVED';
          }
        })
      });
  } catch (error) {
    log('Error retrieving current records from porkbun, ensure api credentials are correct', 'ERROR');
    shutdown('Error reaching porkbun API');
  }
}

async function createRecord(record) {
  const endpoint = `https://api.porkbun.com/api/json/v3/dns/create/${domain}`;
  try {
    const res = await axios.post(endpoint, {
      "secretapikey": secKey, 
      "apikey": apiKey,
      "name": record.name.split('.')[0],
      "type": "A",
      "content": "100.100.100.100",
    });
    records.forEach((r, i, arr) => {
      if (r.name === record.name) {
        arr[i].id = String(res.data.id),
        arr[i].ip = '100.100.100.100';
        arr[i].status = 'CREATED';
        arr[i].updated = getTimestamp();
        log('Created new DNS record for ' + record.name, 'CREATED');
      }
    });
  } catch (error) {
    log('Error creating new DNS record for ' + record.name, 'ERROR');
    shutdown('Unable to create requested record');
  }
}

async function createRecords() {
  const recordsToCreate = records.filter(record => record.status !== 'RETRIEVED');
  const queueLength = 2000; // 2s delay between requests to porkbun API
  for (let i = 0; i < recordsToCreate.length; i++) {
    setTimeout(async () => await createRecord(recordsToCreate[i]), queueLength * i);
  }
}

function verifyConfig() {
  if (!apiKey) {
    log("API key is not set, this value is required (add to .env file)", "ERROR");
    shutdown('Verification error, please fix');
  }
  if (!secKey) {
    log("Secret key is not set, this value is required (add to .env file)", "ERROR");
    shutdown('Verification error, please fix');
  }
  if (!domain) {
    log("Domain name is not set, this value is required (add to .env file)", "ERROR");
    shutdown('Verification error, please fix');
  }
  if (records.length === 0) {
    log("No records to update configured! Configure the SUBDOMAINS_TO_UPDATE, UPDATE_ROOT_DOMAIN, or UPDATE_WILDCARD_DOMAIN .env values", "ERROR");
    shutdown('Verification error, please fix');
  }
}

function log(message, level='INFO') {
  level = '[' + level.substring(0, 8) + ']';
  const logText = `${getTimestamp()} ${level.padEnd(10, ' ')} ${message}`;
  if (level !== "[INFO]") {
    console.log(logText);
  }
  if (logEnabled) {
    fs.appendFileSync(logFile, logText+'\n', (err) => {});
  }
}

function getTimestamp(offsetMs = 0) {
  let date = new Date();
  date.setMilliseconds(date.getMilliseconds() + offsetMs); 
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  var hours = date.getHours() % 12;
  hours = String(hours ? hours : 12).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} ${date.getHours() >= 12 ? 'PM' : 'AM'}`;
}

function shutdown(message="Shutting down") {
  log(message, 'SHUTDOWN');
  process.exit();
}

process.on('SIGTERM', () => shutdown('SIGTERM - Shutting down'));
process.on('SIGINT', () => shutdown('SIGINT - Shutting down'));

(async () => { 
  verifyConfig();
  await retrieveCurrentRecords();
  await createRecords();
  nextIpCheck = getTimestamp(30000);
  setTimeout(scheduledUpdater, 30000);
})();
