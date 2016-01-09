'use strict';

const EE = require('eventemitter3');
const socketStream = require('socket.io-stream');
const progress = require('progress-stream');
const fs = require('fs');
const path = require('path');
const remote = require('electron').remote;
const notifier = require('node-notifier');

var app = remote.app;
const dialog = remote.dialog;

const server = app.server;

var htubeApp = angular.module('htubeApp', ['ngMaterial', 'ngRoute']);
var requestMap = new Map();
var receiveMap = new Map();
var sendQueue = [];
var receiveQueue = [];

function getGuid() {
  function s4() {
    return Math.floor((1 + Math.random()) * 0x10000)
      .toString(16)
      .substring(1);
  }

  return s4() + s4() + '-' + s4() + '-' + s4() + '-' +
    s4() + '-' + s4() + s4() + s4();
}

class FileSender extends EE {
  constructor(socket, controller) {
    super();
    this.socket = socket;
    this.controller = controller;
  }

  onProgressStart(data) {
    console.log('start progress: ' + JSON.stringify(data));
    var t = requestMap.get(data.guid);
    sendQueue.push(t);
    this.controller.sendQueue = sendQueue;

    t.guid = data.guid;
    t.percentage = 0;
    t.currentSize = 0;
    t.transferRate = 0;
    t.isSender = data.isSender;
    this.controller.showProgressPanel();
    this.controller.$apply();
  }

  onProgressUpdate(data) {
    console.log('update progress: ' + JSON.stringify(data));
    var t = requestMap.get(data.guid);
    t.percentage = data.percentage;
    t.currentSize = data.current_size;
    t.transferRate = data.transfer_rate;
    this.controller.$apply();
  }

  onProgressEnd(data) {
    console.log('end progress: ' + JSON.stringify(data));
  }

  sendFileStream(data, file) {
    var t = requestMap.get(data.guid);
    this.transportStream = socketStream(this.socket);
    let pgStream = progress({length: t.size, time: 500});
    this.onProgressStart(data);

    pgStream.on('progress', p => {
      this.onProgressUpdate({
                              guid: data.guid,
                              percentage: p.percentage,
                              total_size: p.length,
                              current_size: p.transferred,
                              transfer_rate: p.speed,
                              eta: p.eta
                            });
    });

    pgStream.on('end', () => {
      this.onProgressEnd(data);
    });

    let writeStream = socketStream.createStream();
    this.transportStream.emit('ev_ss_send_file', writeStream, data);
    fs.createReadStream(file).pipe(pgStream).pipe(writeStream);
    writeStream.on('end', () => {
      this.emit('complete_send_file', data.guid);
    });
  }
}

class P2PFileSender extends FileSender {
  constructor(guid, controller) {
    super();
    this.guid = guid;
    this.controller = controller;
  }

  sendFileStream(data, file) {
    var t = requestMap.get(data.guid);
    var ev = app.streamFile(data, t, file);
    if (ev) {
      this.onProgressStart(data);

      ev.on('progress', p => {
        this.onProgressUpdate({
                                guid: data.guid,
                                percentage: p.percentage,
                                total_size: p.length,
                                current_size: p.transferred,
                                transfer_rate: p.speed,
                                eta: p.eta
                              });
      });

      ev.on('end', () => {
        this.onProgressEnd(data);
      });

      ev.on('stream_end', () => {
        this.emit('complete_send_file', data.guid);
      });
    }
  }
}

class FileReceiver extends EE {
  constructor(socket, controller) {
    super();
    this.socket = socket;
    this.controller = controller;
    this.transportStream = socketStream(this.socket);
    this.transportStream.on('ev_ss_receive_file', this.onReceiveFileStream.bind(this));
  }

  onReceiveFileStream(readStream, data) {
    console.log('ev_ss_receive_file: ' + JSON.stringify(data));
    var t = receiveMap.get(data.guid);

    let pgStream = progress({length: t.size, time: 500});
    this.onProgressStart(data);

    pgStream.on('progress', p => {
      this.onProgressUpdate({
                              guid: data.guid,
                              percentage: p.percentage,
                              total_size: p.length,
                              current_size: p.transferred,
                              transfer_rate: p.speed,
                              eta: p.eta
                            });
    });

    pgStream.on('end', () => {
      this.onProgressEnd(data);
    });

    readStream.pipe(pgStream).pipe(fs.createWriteStream(t.file));
    readStream.on('end', () => {
      this.emit('complete_receive_file', data.guid);
    });
  }

  onProgressStart(data) {
    console.log('start progress: ' + JSON.stringify(data));
    var t = receiveMap.get(data.guid);
    receiveQueue.push(t);
    this.controller.receiveQueue = receiveQueue;
    t.guid = data.guid;
    t.percentage = 0;
    t.currentSize = 0;
    t.transferRate = 0;
    t.isSender = data.isSender;
    this.controller.showProgressPanel();
    this.controller.$apply();
  }

  onProgressUpdate(data) {
    console.log('update progress: ' + JSON.stringify(data));
    var t = receiveMap.get(data.guid);
    t.percentage = data.percentage;
    t.currentSize = data.current_size;
    t.transferRate = data.transfer_rate;
    this.controller.$apply();
  }

  onProgressEnd(data) {
    console.log('end progress: ' + JSON.stringify(data));
  }
}

class Socket extends EE {
  constructor() {
    super();
    this.client = null;
    this.seqId = 1;
    this.seqMap = new Map();
  }

  getSeqId() {
    return this.seqId++;
  }

  request(cmd, args, cb) {
    const seqId = this.getSeqId();
    let payload;
    if (typeof args === 'function') {
      payload = {
        seqId: seqId
      };
      cb = args;
    } else {
      payload = {
        args: args,
        seqId: seqId
      };
    }
    payload.cmd = cmd;
    this.client.emit('cmd', payload);
    this.seqMap.set(seqId, cb);
  }

  connect() {
    this.client = io('ws://' + server, {
      perMessageDeflate: false,
      transports: ['websocket']
    });
    this.socketStream = null;

    this.client.on('connect', this.onConnect.bind(this));
    this.client.on('connect_error', this.onConnectError.bind(this));
    this.client.on('ev_auth_failed', this.onAuth.bind(this));
    this.client.on('ev_hello', this.onServerHello.bind(this));
    this.client.on('ev_ready', this.onReady.bind(this));
    this.client.on('ev_user_connected', this.onUserConnected.bind(this));
    this.client.on('ev_user_disconnected', this.onUserDisconnected.bind(this));
    this.client.on('ev_receive_file', this.onReceiveRequest.bind(this));
    this.client.on('ev_send_file', this.onAcceptRequest.bind(this));
  }

  disconnect() {
    this.client.close();
  }

  reconnect() {
    this.disconnect();
    this.connect();
  }

  listUsers(cb) {
    this.request('cmd_ls', (err, resp) => {
      cb(err, resp);
    });
  }

  register(cb) {
    this.request('cmd_register', [app.wsPort], (err, resp) => {
      console.log(resp);
    });
  }

  sendRequest(userGuid, name, size, requestGuid) {
    this.request('cmd_send_file', [userGuid, name, size, requestGuid], (err, resp) => {
      console.log(resp + ' ' + userGuid + ' ' + name + ': ' + size + ' ' + requestGuid);
    });
  }

  acceptRequest(userGuid, requestGuid, isP2P) {
    this.request('cmd_receive_file', [userGuid, requestGuid, isP2P], (err, resp) => {
      console.log(resp + ' ' + userGuid + ' ' + requestGuid + ' ' + isP2P);
    });
  }

  completeRequest(requestGuid) {
    this.request('cmd_complete_request', [requestGuid], (err, resp) => {
      console.log(resp);
    });
  }

  onConnect() {
    console.log('connected to server! waiting for server message.');
    this.register();
    this.emit('connected');
  }

  onAuth() {
    console.log('server require you to auth.');
    this.emit('auth_required');
  }

  onServerHello(data) {
    console.log('received server hello message: %s', data.message);
    this.emit('hello', data);
  }

  onConnectError(err) {
    this.client.close();
    console.log('failed to connect to server' + err);
    this.emit('error', err);
  }

  onUserConnected() {
    console.log('user connected');
    this.emit('user_connected');
  }

  onUserDisconnected() {
    console.log('user disconnected');
    this.emit('user_disconnected');
  }

  onReady(data) {
    console.log('server callback. seqId: ', data.seqId);
    const cb = this.seqMap.get(data.seqId);
    cb(data.error, data.response);
    this.seqMap.delete(data.seqId);
  }

  onReceiveRequest(data) {
    this.emit('receive_request', data);
  }

  onAcceptRequest(data) {
    this.emit('start_send_file', data);
  }
}

htubeApp.config(['$routeProvider', '$mdThemingProvider', function($routeProvider, $mdThemingProvider) {
    $routeProvider
      .when('/', {
        templateUrl: 'templates/login.html',
        controller: 'LoginController'
      })
      .when('/list', {
        templateUrl: 'templates/list.html',
        controller: 'ListUsersController'
      });

    $mdThemingProvider.theme('default');
  }])
  .run(['$rootScope', '$location', '$window', function($rootScope, $location, $window) {
    $window.location.href = "#";
  }]);

htubeApp.controller('LoginController', ['$scope', '$location', 'socket', ($scope, $location, socket) => {
  $scope.master = {};

  $scope.$on('$viewContentLoaded', function() {
    var loginView = document.getElementById('login');

    document.ondragover = document.ondrop = function () {
        return false;
    };

    loginView.addEventListener("dom-ready", function() {
      // fix font
      loginView.insertCSS('body { overflow:hidden; background-color: white ! important; }');
    });

    loginView.addEventListener("did-get-redirect-request", function(ev) {
      console.log('login view has redirect request.', ev);
      socket.reconnect();
    });

    socket.connect();

    socket.on('auth_required', () => {
      loginView.style.visibility = 'visible';
    });

    socket.on('hello', (data) => {
      socket.session = {
        userProfile: data.profile
      };
      $location.path('/list');
      $scope.$apply();
    });
  });
}]);

htubeApp.controller('ListUsersController', ['$scope', 'socket', '$mdDialog', function($scope, socket, $mdDialog) {
  $scope.userProfile = socket.session.userProfile;
  console.log(socket.session.userProfile)

  $scope.refreshUser = function refreshUser() {
    socket.listUsers((err, users) => {
      console.log('list of users: ' + JSON.stringify(users));
      $scope.onUserUpdated(users);
    });
  };

  $scope.onUserUpdated = function onUserUpdated(users) {
    $scope.users = users.filter(function (user) { return user.userGuid != socket.session.userProfile.userGuid });
    users.sort(function(user1, user2){
        user1 = user1.profile;
	user2 = user2.profile;
        if (user1.firstName == user2.firstName){
            if (user1.lastName == user2.lastName){
                return 0;
            }else{
                return user1.lastName > user2.lastName ? 1 : -1;
            }
        }else{
            return user1.firstName > user2.firstName ? 1 : -1;
        }
    });
    $scope.users = users;
    $scope.$apply();
  };

  $scope.sendRequest = function sendRequest(user, file) {
    dialog.showOpenDialog({properties: ['openFile']}, (files) => {
      properties: ['openFile']
    }, (files) => {
      let name = path.basename(file);
      let size = fs.statSync(file).size;
      let requestGuid = getGuid();
      app.registerTransportGuid(requestGuid);
      socket.sendRequest(user.profile.userGuid, name, size, requestGuid);
      let t = {
              name: name,
              file: file,
              size: size,
              user: user,
      }
      console.log(JSON.stringify(t));
      requestMap.set(requestGuid, t);
    });
  };
  
  $scope.clickPerson = function clickPerson(user) {
    dialog.showOpenDialog({properties: ['openFile']}, (files) => {
      if (files && files.length > 0) {
          this.sendRequest(user, files[0]);
      }
    });
  };

  $scope.closeProgress = function closeProgress(transmission) {
    if (transmission.percentage == 100) {
      if (transmission.isSender) {
        sendQueue.splice(sendQueue.indexOf(transmission), 1);
        requestMap.delete(transmission.guid);
      } else {
        receiveQueue.splice(receiveQueue.indexOf(transmission), 1);
        receiveMap.delete(transmission.guid);
      }
      if (sendQueue.length == 0 && receiveQueue.length == 0) {
        $scope.hideProgressPanel();
      }
    }
  };

  $scope.showProgressPanel = function showProgressPanel() {
    var progressPanel = document.getElementById('progress-panel');
    progressPanel.style.display = 'block';
  }

  $scope.hideProgressPanel = function hideProgressPanel() {
    var progressPanel = document.getElementById('progress-panel');
    progressPanel.style.display = 'none';
  }

  $scope.bytesToSize = bytesToSize;

  function bytesToSize(bytes) {
    var sizes = ['bytes', 'KB', 'MB', 'GB', 'TB'];
    if (bytes == 0) return '0 Byte';
    var i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
    return Math.round(bytes / Math.pow(1024, i), 2) + ' ' + sizes[i];
  };

  function findUser(userGuid) {
    var user = $scope.users.filter(function(user) {
      return user.profile.userGuid == userGuid
    });
    if (user.length > 0) {
      return user[0];
    }
  }

  socket.on('user_connected', () => {
    $scope.refreshUser();
  });

  socket.on('user_disconnected', () => {
    $scope.refreshUser();
  });

  socket.on('receive_request', (data) => {
    console.log('receive_request: ' + JSON.stringify(data));
    var sender = findUser(data.sender);
    var choice = dialog.showMessageBox({
      type: 'question',
      buttons: ['No', 'Yes'],
      title: 'Incoming File',
      message: sender.profile.firstName + ' ' + sender.profile.lastName + ' wants to send you ' + data.file +
        ' (' + bytesToSize(data.fileSize) + '). Accept?'
    });
    if (choice) {
      let directories = dialog.showOpenDialog({
        properties: ['openDirectory']
      });

      if (directories) {
        let t = {
          name: data.file,
          file: path.join(directories[0], data.file),
          size: data.fileSize,
          user: sender
        };
        receiveMap.set(data.guid, t);

        // try p2p channel
        let p2pSocket = io(sender.p2pUri, {
          perMessageDeflate: false,
          transports: ['websocket']
        });

        p2pSocket.on('connect_error', () => {
          // send through server
          t.receiver = new FileReceiver(socket.client, $scope);
          socket.acceptRequest(data.sender, data.guid, false);
          t.receiver.on('complete_receive_file', (guid) => {
            console.log(guid + ' receive done! receiveMap: ');
            console.log(receiveMap);
            socket.completeRequest(guid);
          });
        });

        p2pSocket.once('connect', () => {
          // open p2p channel
          p2pSocket.emit('open_file_transport', data.guid);
          p2pSocket.on('file_transport_opened', () => {
            // send through p2p
            console.log('p2p channel is open');
            t.receiver = new FileReceiver(p2pSocket, $scope);
            socket.acceptRequest(data.sender, data.guid, true);
            t.receiver.on('complete_receive_file', (guid) => {
              console.log(guid + ' receive done! receiveMap: ');
              console.log(receiveMap);
              socket.completeRequest(guid);
            });
          });

          p2pSocket.on('file_transport_failed', () => {
            // send through server
            t.receiver = new FileReceiver(socket.client, $scope);
            socket.acceptRequest(data.sender, data.guid, false);
            t.receiver.on('complete_receive_file', (guid) => {
              console.log(guid + ' receive done! receiveMap: ');
              console.log(receiveMap);
              socket.completeRequest(guid);
            });
          });
        });
      }
    }
  });

  socket.on('start_send_file', (data) => {
    console.log('start sending file: ' + JSON.stringify(data));
    let t = requestMap.get(data.guid);
    let fileSender = null;
    if (data.isP2P) {
      fileSender = new P2PFileSender(data.guid, $scope);
    } else {
      fileSender = new FileSender(socket.client, $scope);
    }

    t.sender = fileSender;
    fileSender.sendFileStream(data, t.file);
    fileSender.on('complete_send_file', (guid) => {
      //requestMap.delete(guid);
      console.log(guid + ' send done! requestMap: ');
      console.log(requestMap);

      var t;
      var message;
      if (data.isSender) {
          t = requestMap.get(data.guid);
          message = t.name + ' has been sent.';
      }else{
          t = receiveMap.get(data.guid);
          message = t.name + ' has been received.';
      }
      notifier.notify({
          'title': 'Transmission Completed',
          'message': message,
      });
    });
  });

  socket.on('complete_send_file', (guid) => {
    console.log(guid + ' send done! requestMap: ');
    console.log(requestMap);
  });

  socket.on('complete_receive_file', (guid) => {
    console.log(guid + ' receive done! receiveMap: ');
    console.log(receiveMap);
    socket.completeRequest(guid);
  });

  $scope.refreshUser();
}])
.directive('dragAndDrop', function() {
    return {
        restrict: 'A',
        link: function($scope, elem, attr) {
          elem.bind('drop', function(e) {
              e.preventDefault();
              let files = e.dataTransfer.files;
              if (files && files.length > 0){
                  $scope.sendRequest($scope.user, files[0].path);
              }
              return false;
          });
        }
   };
});

htubeApp.factory('socket', function() {
  return new Socket();
});
