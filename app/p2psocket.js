'use strict';

const http = require('http');
const io = require('socket.io');
const socketStream = require('socket.io-stream');
const progress = require('progress-stream');
const electron = require('electron');
const fs = require('fs');
const app = electron.app;
const EE = require('events').EventEmitter;

var server = http.createServer();

const transportGuids = {};

// base port, will try nearest port if base port is in use
app.wsPort = 8901;

app.registerTransportGuid = function registerTransportGuid(guid) {
  transportGuids[guid] = {};
}

class StreamEvent extends EE {
  constructor() {
    super();
  }
}

app.streamFile = function streamFile(data, t, file) {
  let transportSocket = transportGuids[data.guid].socket;
  if (transportSocket) {
    let se = new StreamEvent();
    
    let transportStream = socketStream(transportSocket);
    let pgStream = progress({length: t.size, time: 500});

    pgStream.on('progress', p => {
      se.emit('progress', p);
    });

    pgStream.on('end', () => {
      se.emit('end');
    });

    let writeStream = socketStream.createStream();
    
    transportStream.emit('ev_ss_receive_file', writeStream, data);
    
    fs.createReadStream(file).pipe(pgStream).pipe(writeStream);

    writeStream.on('end', () => {
      se.emit('stream_end');
    });

    return se;
  }
  return null;
}

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
  function openFileTransport(guid) {
    // get transport info by guid
    if (guid in transportGuids) {
      transportGuids[guid].socket = socket;
      socket.emit('file_transport_opened');
    } else {
      socket.emit('file_transport_failed');
    }
  }

  socket.on('open_file_transport', openFileTransport);

  socket.on('error', (err) => {
    console.log(err);
  });

  socket.on('disconnect', () => {
    console.log('client disconnected');
  });
});

