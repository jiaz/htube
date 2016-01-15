'use strict';

const debug = require('debug')('htube:p2psocket')
const http = require('http');
const io = require('socket.io');
const ioClient = require('socket.io-client');
const socketStream = require('socket.io-stream');
const progress = require('progress-stream');
const electron = require('electron');
const fs = require('fs');
const app = electron.app;
const EE = require('events').EventEmitter;
const util = require('util');

var server = http.createServer();

const transportGuids = {};

// base port, will try nearest port if base port is in use
app.wsPort = 8901;

app.registerTransportGuid = function registerTransportGuid(guid) {
  transportGuids[guid] = {};
};

function streamFile(data, file) {
  return null;
}

function P2PFileSender(guid, size) {
  EE.call(this);
  this.guid = guid;
  this.size = size;
}
util.inherits(P2PFileSender, EE);

P2PFileSender.prototype.sendFileStream = function sendFileStream(data, file) {
  let transportSocket = transportGuids[data.guid].socket;
  if (transportSocket) {
    let transportStream = socketStream(transportSocket);
    let pgStream = progress({
      length: this.size,
      time: 500
    });

    this.emit('start', data);

    pgStream.on('progress', p => {
      this.emit('progress', {
        guid: data.guid,
        percentage: p.percentage,
        total_size: p.length,
        current_size: p.transferred,
        transfer_rate: p.speed,
        eta: p.eta
      });
    });

    let writeStream = socketStream.createStream();

    transportStream.emit('ev_ss_receive_file', writeStream, data);

    fs.createReadStream(file).pipe(pgStream).pipe(writeStream);

    writeStream.on('end', () => {
      this.emit('end', data);
    });
  } else {
    this.emit('error', 'failed to send file');
  }
};

app.P2PFileSender = P2PFileSender;

function P2PFileReceiver(uri, size, file) {
  EE.call(this);
  debug('create receiver to receive file: ' + file);
  this.size = size;
  this.uri = uri;
  this.file = file;
  this.socket = null;
  this.transportStream = null;
}
util.inherits(P2PFileReceiver, EE);

P2PFileReceiver.prototype.connect = function connect() {
  this.socket = ioClient(this.uri, {
    perMessageDeflate: false,
    transports: ['websocket']
  });

  this.socket.on('connect_error', () => {
    debug('p2p socket connect failed');
    this.emit('connect_error');
  });

  this.socket.on('connect', () => {
    debug('p2p socket connected');
    this.transportStream = socketStream(this.socket);
    this.transportStream.on('ev_ss_receive_file', this.onReceiveFileStream.bind(this));
    this.emit('connect');
  });
};

P2PFileReceiver.prototype.openFileTransport = function openFileTransport(data) {
  this.socket.emit('open_file_transport', data);
  this.socket.once('file_transport_opened', () => {
    this.emit('file_transport_opened');
  });
  this.socket.once('file_transport_failed', () => {
    this.emit('file_transport_failed');
  });
}

P2PFileReceiver.prototype.onReceiveFileStream = function onReceiveFileStream(readStream, data) {
  debug('ev_ss_receive_file: ' + JSON.stringify(data));

  let pgStream = progress({
    length: this.size,
    time: 500
  });

  this.emit('start', data);

  pgStream.on('progress', p => {
    this.emit('progress', {
      guid: data.guid,
      percentage: p.percentage,
      total_size: p.length,
      current_size: p.transferred,
      transfer_rate: p.speed,
      eta: p.eta
    });
  });

  readStream.pipe(pgStream).pipe(fs.createWriteStream(this.file));
  readStream.on('end', () => {
    this.emit('end', data);
  });
};

app.P2PFileReceiver = P2PFileReceiver;

// create socket.io server
const ioServer = io(server, {
  serveClient: false,
  transports: ['websocket'],
  perMessageDeflate: false,
  httpCompression: false,
});

(function doListen() {
  function tryListen(err) {
    app.wsPort++;
    doListen();
  }
  server.listen(app.wsPort, () => {
    server.removeListener('error', tryListen);
  });
  server.on('error', tryListen);
})();

ioServer.on('connection', (socket) => {
  function openFileTransport(data) {
    debug(data.guid);
    debug(transportGuids);
    // get transport info by guid
    if (data.guid in transportGuids) {
      transportGuids[data.guid].socket = socket;
      socket.emit('file_transport_opened');
    } else {
      socket.emit('file_transport_failed');
    }
  }

  socket.on('open_file_transport', openFileTransport);

  socket.on('error', (err) => {
    console.error(err);
  });

  socket.on('disconnect', () => {
    debug('client disconnected');
  });
});
