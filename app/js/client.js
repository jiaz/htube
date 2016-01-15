'use strict';

const EE = require('eventemitter3');
const socketStream = require('socket.io-stream');
const progress = require('progress-stream');
const fs = require('fs');
const path = require('path');
const remote = require('electron').remote;
const notifier = require('node-notifier');

const dialog = remote.dialog;

const app = remote.app;
const server = app.server;
const P2PFileSender = app.P2PFileSender;
const P2PFileReceiver = app.P2PFileReceiver;

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

function bytesToSize(bytes) {
  var sizes = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  if (bytes == 0) return '0 Byte';
  var i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
  return Math.round(bytes / Math.pow(1024, i), 2) + ' ' + sizes[i];
};

class FileSender extends EE {
  constructor(socket) {
    super();
    this.socket = socket;
  }

  sendFileStream(data, file) {
    this.transportStream = socketStream(this.socket);
    
    let pgStream = progress({
      length: data.size,
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

    this.transportStream.emit('ev_ss_send_file', writeStream, data);
    fs.createReadStream(file).pipe(pgStream).pipe(writeStream);
    writeStream.on('end', () => {
      this.emit('end', data);
    });
  }
}

class FileReceiver extends EE {
  constructor(socket, size, file) {
    super();
    this.socket = socket;
    this.file = file;
    this.size = size;
    this.transportStream = socketStream(this.socket);
    this.transportStream.on('ev_ss_receive_file', this.onReceiveFileStream.bind(this));
  }

  onReceiveFileStream(readStream, data) {
    console.log('ev_ss_receive_file: ' + JSON.stringify(data));

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

    document.ondragover = document.ondrop = function() {
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
    users = users.filter(function(user) {
      return user.profile.userGuid !== socket.session.userProfile.userGuid
    });
    users.sort(function(user1, user2) {
      user1 = user1.profile;
      user2 = user2.profile;
      if (user1.firstName == user2.firstName) {
        if (user1.lastName == user2.lastName) {
          return 0;
        } else {
          return user1.lastName > user2.lastName ? 1 : -1;
        }
      } else {
        return user1.firstName > user2.firstName ? 1 : -1;
      }
    });
    $scope.users = users;
    $scope.$apply();
  };

  $scope.sendRequest = function sendRequest(user, file) {
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
  };

  $scope.clickPerson = function clickPerson(user) {
    dialog.showOpenDialog({
      properties: ['openFile']
    }, (files) => {
      if (files && files.length > 0) {
        this.sendRequest(user, files[0]);
      }
    });
  };

  $scope.onSendProgressStart = function onSendProgressStart(data) {
    console.log('start send progress: ' + JSON.stringify(data));
    var t = requestMap.get(data.guid);
    sendQueue.push(t);
    $scope.sendQueue = sendQueue;
    t.guid = data.guid;
    t.percentage = 0;
    t.currentSize = 0;
    t.transferRate = 0;
    $scope.showProgressPanel();
    $scope.$apply();
  };

  $scope.onSendProgressUpdate = function onSendProgressUpdate(data) {
    console.log('update send progress: ' + JSON.stringify(data));
    var t = requestMap.get(data.guid);
    t.percentage = data.percentage;
    t.currentSize = data.current_size;
    t.transferRate = data.transfer_rate;
    $scope.$apply();
  };

  $scope.onSendProgressEnd = function onSendProgressEnd(data) {
    console.log('end send progress: ' + JSON.stringify(data));
    console.log(data.guid + ' send done! requestMap: ');
    console.log(requestMap);
    $scope.notifySendComplete(data);
  };

  $scope.onReceiveProgressStart = function onReceiveProgressStart(data) {
    console.log('start receive progress: ' + JSON.stringify(data));
    var t = receiveMap.get(data.guid);
    receiveQueue.push(t);
    $scope.receiveQueue = receiveQueue;
    t.guid = data.guid;
    t.percentage = 0;
    t.currentSize = 0;
    t.transferRate = 0;
    $scope.showProgressPanel();
    $scope.$apply();
  };

  $scope.onReceiveProgressUpdate = function onProgressUpdate(data) {
    console.log('update receive progress: ' + JSON.stringify(data));
    var t = receiveMap.get(data.guid);
    t.percentage = data.percentage;
    t.currentSize = data.current_size;
    t.transferRate = data.transfer_rate;
    $scope.$apply();
  };

  $scope.onReceiveProgressEnd = function onReceiveProgressEnd(data) {
    console.log('end receive progress: ' + JSON.stringify(data));
    console.log(data.guid + ' receive done! receiveMap: ');
    console.log(receiveMap);
    $scope.notifyReceiveComplete(data);
    socket.completeRequest(data.guid);
  };

  $scope.closeSendProgress = function closeSendProgress(transmission) {
    if (transmission.percentage == 100) {
      sendQueue.splice(sendQueue.indexOf(transmission), 1);
      requestMap.delete(transmission.guid);
      if (sendQueue.length == 0 && receiveQueue.length == 0) {
        $scope.hideProgressPanel();
      }
    }
  };

  $scope.closeReceiveProgress = function closeReceiveProgress(transmission) {
    if (transmission.percentage == 100) {
      receiveQueue.splice(receiveQueue.indexOf(transmission), 1);
      receiveMap.delete(transmission.guid);

      if (sendQueue.length == 0 && receiveQueue.length == 0) {
        $scope.hideProgressPanel();
      }
    }
  };

  $scope.showProgressPanel = function showProgressPanel() {
    var progressPanel = document.getElementById('progress-panel');
    progressPanel.style.display = 'block';
  };

  $scope.hideProgressPanel = function hideProgressPanel() {
    var progressPanel = document.getElementById('progress-panel');
    progressPanel.style.display = 'none';
  };

  $scope.bytesToSize = bytesToSize;

  $scope.notifySendComplete = function notifySendComplete(data) {
    var t = requestMap.get(data.guid);
    var message = t.name + ' has been sent.';
    notifier.notify({
      'title': 'Transmission Completed',
      'message': message,
    });
  };

  $scope.notifyReceiveComplete = function notifyReceiveComplete(data) {
    var t = receiveMap.get(data.guid);
    var message = t.name + ' has been received.';
    notifier.notify({
      'title': 'Transmission Completed',
      'message': message,
    });
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
      let chosenPath = dialog.showSaveDialog({
        defaultPath: path.join(app.getPath('downloads'), data.file)
      });

      if (chosenPath) {
        let t = {
          name: data.file,
          file: chosenPath,
          size: data.fileSize,
          user: sender
        };
        receiveMap.set(data.guid, t);

        // try p2p channel
        let p2pReceiver = new P2PFileReceiver(sender.p2pUri, t.size, t.file);

        function bindEvents(receiver) {
          receiver.on('start', $scope.onReceiveProgressStart.bind($scope));
          receiver.on('progress', $scope.onReceiveProgressUpdate.bind($scope));
          receiver.on('end', $scope.onReceiveProgressEnd.bind($scope));
        }

        p2pReceiver.connect();

        p2pReceiver.once('connect_error', () => {
          // send through server
          t.receiver = new FileReceiver(socket.client, t.size, t.file);
          bindEvents(t.receiver);
          socket.acceptRequest(data.sender, data.guid, false);
        });

        p2pReceiver.once('connect', () => {
          // open p2p channel
          p2pReceiver.openFileTransport(data);
          p2pReceiver.on('file_transport_opened', () => {
            // send through p2p
            console.log('p2p channel is open');
            t.receiver = p2pReceiver;
            bindEvents(t.receiver);
            socket.acceptRequest(data.sender, data.guid, true);
          });

          p2pReceiver.on('file_transport_failed', () => {
            console.error('error! cannot complete file transport request.');
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
      fileSender = new P2PFileSender(data.guid, t.size);
    } else {
      fileSender = new FileSender(socket.client);
    }

    t.sender = fileSender;
    fileSender.on('start', $scope.onSendProgressStart.bind($scope));
    fileSender.on('progress', $scope.onSendProgressUpdate.bind($scope));
    fileSender.on('end', $scope.onSendProgressEnd.bind($scope));

    fileSender.sendFileStream(data, t.file);
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
        if (files && files.length > 0) {
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
