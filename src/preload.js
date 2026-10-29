'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('aegis', {
  auth: {
    status: () => invoke('auth:status'),
    setup: (username, passphrase) => invoke('auth:setup', { username, passphrase }),
    confirm: (code) => invoke('auth:confirm', { code }),
    login: (username, passphrase, code) => invoke('auth:login', { username, passphrase, code }),
    setUsername: (username) => invoke('auth:set-username', { username }),
    lock: () => invoke('auth:lock'),
    touch: () => invoke('auth:touch'),
    wipe: () => invoke('auth:wipe'),
    onLocked: (cb) => ipcRenderer.on('auth:locked', (e, info) => cb(info)),
  },
  tabs: {
    create: (url, background) => invoke('tabs:create', { url, background }),
    close: (id) => invoke('tabs:close', { id }),
    activate: (id) => invoke('tabs:activate', { id }),
    list: () => invoke('tabs:list'),
    back: (id) => invoke('tabs:back', { id }),
    forward: (id) => invoke('tabs:forward', { id }),
    reload: (id) => invoke('tabs:reload', { id }),
    stop: (id) => invoke('tabs:stop', { id }),
    navigate: (id, input) => invoke('tabs:navigate', { id, input }),
    onChanged: (cb) => ipcRenderer.on('tabs:changed', (e, list) => cb(list)),
  },
  ai: {
    summarize: (tabId) => invoke('ai:summarize', { tabId }),
    ask: (tabId, question) => invoke('ai:ask', { tabId, question }),
    autopilot: (task) => invoke('ai:autopilot', { task }),
    // Health briefing from the attached ErrorModel (counts + plain-language advice)
    diagnose: () => invoke('ai:diagnose'),
    onDiagnoseRequest: (cb) => ipcRenderer.on('ai:diagnose-request', (e, p) => cb(p)),
    onDiagEvent: (cb) => ipcRenderer.on('diag:event', (e, ev) => cb(ev)),
    onAutopilotProgress: (cb) => ipcRenderer.on('ai:autopilot-progress', (e, p) => cb(p)),
    onAskRequest: (cb) => ipcRenderer.on('ai:ask-request', (e, p) => cb(p)),
    onSummarizeRequest: (cb) => ipcRenderer.on('ai:summarize-request', (e, p) => cb(p)),
  },
  diag: {
    report: () => invoke('diag:report'),
    seen: () => invoke('diag:seen'),
  },
  ext: {
    list: () => invoke('ext:list'),
    install: (key) => invoke('ext:install', key),
    uninstall: (key) => invoke('ext:uninstall', key),
    loadUnpacked: () => invoke('ext:unpacked'),
    refresh: () => invoke('ext:refresh'),
    installUrl: (url, sha256) => invoke('ext:install-url', { url, sha256 }),
    pickFolder: () => invoke('ext:pick-folder'),
    publish: (payload) => invoke('ext:publish', payload),
    reveal: (file) => invoke('ext:reveal', file),
  },
  openExternal: (url) => invoke('app:open-external', url),
  privacy: {
    clean: (what) => invoke('privacy:clean', { what }),
    status: () => invoke('privacy:status'),
    onCleaned: (cb) => ipcRenderer.on('privacy:cleaned', (e, info) => cb(info)),
  },
  history: {
    list: (query, limit) => invoke('history:list', { query, limit }),
    delete: (id) => invoke('history:delete', { id }),
    clear: () => invoke('history:clear'),
  },
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
    setSecrets: (s) => invoke('secrets:set', s),
  },
  net: {
    status: () => invoke('net:status'),
  },
  ui: {
    viewport: (rect) => invoke('ui:viewport', rect),
    overlay: (name) => invoke('ui:overlay', name),
    onNotify: (cb) => ipcRenderer.on('notify', (e, n) => cb(n)),
  },
  activity: () => ipcRenderer.invoke('auth:touch'),
});
