'use strict';

const electron = require('electron');
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;

var server = 'jiaji-salttest-1.server.hulu.com:8500';

electron.crashReporter.start({
  companyName: 'com.hulu',
  submitURL: server
});

let mainWindow = null;

app.server = server;

app.on('window-all-closed', () => {
  app.quit();
});

app.on('ready', () => {
  mainWindow = new BrowserWindow({
    width: 440,
    height: 700,
    resizable: false,
    'title-bar-style': 'hidden',
    icon: __dirname + '/resources/logo.png'
  });

  mainWindow.webContents.openDevTools({detach: true});

  if (process.env['NO_CACHE'] == '1') {
    mainWindow.webContents.session.clearStorageData({
      storages: ['cookies', 'local storage']
    }, () => {
      mainWindow.loadURL('file://' + __dirname + '/index.html');
    });
  } else {
    mainWindow.loadURL('file://' + __dirname + '/index.html');
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
});

require('./p2psocket');
