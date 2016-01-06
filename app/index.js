'use strict';

const electron = require('electron');
const app = require('app');
const BrowserWindow = require('browser-window');

electron.crashReporter.start({
  companyName: 'com.hulu',
  submitURL: 'localhost.hulu.com'
});

let mainWindow = null;

app.on('window-all-closed', () => {
  app.quit();
});

app.on('ready', () => {
  mainWindow = new BrowserWindow({
    width: 440,
    height: 700,
    resizable: false
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
