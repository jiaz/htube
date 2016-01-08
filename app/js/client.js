'use strict';

var EE = require('eventemitter3');
var remote = require('remote');
var app = remote.require('app');
var socketStream = require('socket.io-stream');
const dialog = remote.dialog;
const fs = require('fs');
const path = require('path');
const notifier = require('node-notifier');

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
      payload = {seqId: seqId};
      cb = args;
    } else {
      payload = {args: args, seqId: seqId};
    }
    payload.cmd = cmd;
    this.client.emit('cmd', payload);
    this.seqMap.set(seqId, cb);
  }

  connect() {
    this.client = io('http://jiaji-salttest-1.server.hulu.com:8099', {
      perMessageDeflate: false,
      transports: ['websocket']
    });
    this.socketStream = null;

    this.client.on('connect', this.onConnect.bind(this));
    this.client.on('connect_error', this.onConnectError.bind(this));
    this.client.on('ev_auth_required', this.onAuth.bind(this));
    this.client.on('ev_hello', this.onServerHello.bind(this));
    this.client.on('ev_ready', this.onReady.bind(this));
    this.client.on('ev_user_connected', this.onUserConnected.bind(this));
    this.client.on('ev_user_disconnected', this.onUserDisconnected.bind(this));
    this.client.on('ev_receive_file', this.onReceiveRequest.bind(this));
    this.client.on('ev_send_file', this.onAcceptRequest.bind(this));
    this.client.on('ev_progress_start', this.onProgressStart.bind(this));
    this.client.on('ev_progress_update', this.onProgressUpdate.bind(this));
    this.client.on('ev_progress_end', this.onProgressEnd.bind(this));
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

  sendRequest(userGuid, name, size, requestGuid) {
      this.request('cmd_send_file', [userGuid, name, size, requestGuid], (err, resp) => {
          console.log(resp + ' ' + userGuid + ' ' + name + ': ' + size + ' ' + requestGuid);
      });
  }

  acceptRequest(userGuid, requestGuid) {
      this.request('cmd_receive_file', [userGuid, requestGuid], (err, resp) => {
          console.log(resp + ' ' + userGuid + ' ' + requestGuid);
      });
  }

  sendFileStream(params, file) {
    let writeStream = socketStream.createStream();
    this.socketStream.emit('ev_ss_send_file', writeStream, params);
    fs.createReadStream(file).pipe(writeStream);
    writeStream.on('end', () => {
        this.emit('complete_send_file', params.guid);
    });
  }

  onReceiveFileStream(readStream, params) {
    console.log('ev_ss_receive_file: ' + JSON.stringify(params));
    readStream.pipe(fs.createWriteStream(receiveMap.get(params.guid).file));
    readStream.on('end', () => {
        this.emit('complete_receive_file', params.guid);
    });
  }

  onConnect() {
    console.log('connected to server! waiting for server message.');

    this.socketStream = socketStream(this.client);
    this.socketStream.on('ev_ss_receive_file', this.onReceiveFileStream.bind(this));

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

  onProgressStart(data) {
      this.emit('start_progress', data);
  }

  onProgressUpdate(data) {
      this.emit('update_progress', data);
  }

  onProgressEnd(data) {
      this.emit('end_progress', data);
  }
}

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

htubeApp.config(['$routeProvider', '$mdThemingProvider', function ($routeProvider, $mdThemingProvider) {
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
  .run(['$rootScope', '$location', '$window', function ($rootScope, $location, $window) {
    $window.location.href = "#";
  }]);

htubeApp.controller('LoginController', ['$scope', '$location', 'socket', ($scope, $location, socket) => {
  $scope.master = {};

  $scope.$on('$viewContentLoaded', function () {
    var loginView = document.getElementById('login');

    document.ondragover = document.ondrop = function () {
        return false;
    };

    loginView.addEventListener("dom-ready", function () {
      // fix font
      loginView.insertCSS('body { overflow:hidden; background-color: white ! important; }');
    });

    loginView.addEventListener("did-get-redirect-request", function (ev) {
      console.log('login view has redirect request.', ev);
      socket.reconnect();
    });

    socket.connect();

    socket.on('auth_required', () => {
      loginView.style.visibility = 'visible';
    });

    socket.on('hello', (data) => {
      socket.session = data.session;
      $location.path('/list');
      $scope.$apply();
    });
  });
}]);

htubeApp.controller('ListUsersController', ['$scope', 'socket', '$mdDialog', function ($scope, socket, $mdDialog) {
  var progressPanel = document.getElementById('progress-panel');
  $scope.userProfile = socket.session.userProfile;

  $scope.refreshUser = function refreshUser() {
    socket.listUsers((err, users) => {
      console.log('list of users: ' + JSON.stringify(users));
      $scope.onUserUpdated(users);
    });
  };

  $scope.onUserUpdated = function onUserUpdated(users) {
    users = users.filter(function (user) { return user.userGuid != socket.session.userProfile.userGuid });
    users.sort(function(user1, user2){
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

  $scope.clickPerson = function clickPerson(user) {
    dialog.showOpenDialog({properties: ['openFile']}, (files) => {
      if (files) {
          let file = files[0];
          let name = path.basename(file);
          let size = fs.statSync(file).size;
          let requestGuid = getGuid();
          socket.sendRequest(user.userGuid, name, size, requestGuid);
          let t = {
                  name: name,
                  file: file,
                  size: size,
                  user: user,
          }
          console.log(JSON.stringify(t));
          requestMap.set(requestGuid, t);
      }
    });
  };

  $scope.closeProgress = function closeProgress(transmission) {
      if (transmission.percentage == 100){
          if (transmission.isSender) {
              sendQueue.splice(sendQueue.indexOf(transmission), 1);
              requestMap.delete(transmission.guid);
          }else{
              receiveQueue.splice(receiveQueue.indexOf(transmission), 1);
              receiveMap.delete(transmission.guid);
          }
          if (sendQueue.length == 0 && receiveQueue.length ==0) {
              progressPanel.style.display = 'none';
          }
      }
  };

  $scope.bytesToSize = bytesToSize;

  function bytesToSize(bytes) {
      var sizes = ['bytes', 'KB', 'MB', 'GB', 'TB'];
      if (bytes == 0) return '0 Byte';
      var i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
      return Math.round(bytes / Math.pow(1024, i), 2) + ' ' + sizes[i];
  };
  
  function findUser(userGuid) {
      var user = $scope.users.filter(function (user) { return user.userGuid == userGuid });
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
      var choice = dialog.showMessageBox({type: 'question', buttons: ['No', 'Yes'],
          title: 'Incoming File', message: sender.firstName + ' ' + sender.lastName + ' wants to send you ' + data.file +
          ' (' + bytesToSize(data.fileSize) + '). Accept?'});
      if (choice) {
          let directories = dialog.showOpenDialog({properties: ['openDirectory']});
          if (directories) {
              socket.acceptRequest(data.sender, data.guid);
              let t = {
                      name: data.file,
                      file: path.join(directories[0], data.file),
                      size: data.fileSize,
                      user: sender,
              }
              receiveMap.set(data.guid, t);
          }
      }
  });

  socket.on('start_send_file', (data) => {
      console.log('start sending file: ' + requestMap.get(data.guid).file);
      socket.sendFileStream(data, requestMap.get(data.guid).file);
  });

  socket.on('start_progress', (data) => {
      console.log('start progress: ' + JSON.stringify(data));
      var t;
      if (data.isSender) {
          t = requestMap.get(data.guid);
          sendQueue.push(t);
          $scope.sendQueue = sendQueue;
      }else{
          t = receiveMap.get(data.guid);
          receiveQueue.push(t);
          $scope.receiveQueue = receiveQueue;
      }
      t.guid = data.guid;
      t.percentage = 0;
      t.currentSize = 0;
      t.transferRate = 0;
      t.isSender = data.isSender;
      progressPanel.style.display = 'block';
      $scope.$apply();
  });

  socket.on('update_progress', (data) => {
      console.log('update progress: ' + JSON.stringify(data));
      var t;
      if (data.isSender) {
          t = requestMap.get(data.guid);
      }else{
          t = receiveMap.get(data.guid);
      }
      t.percentage = data.percentage;
      t.currentSize = data.current_size;
      t.transferRate = data.transfer_rate;
      $scope.$apply();
  });

  socket.on('end_progress', (data) => {
      console.log('end progress: ' + JSON.stringify(data));
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

  socket.on('complete_send_file', (guid) => {
      console.log(guid + ' send done! requestMap: ');
      console.log(requestMap);
  });

  socket.on('complete_receive_file', (guid) => {
      console.log(guid + ' receive done! receiveMap: ');
      console.log(receiveMap);
  });

  $scope.refreshUser();
}]);

htubeApp.factory('socket', function () {
  return new Socket();
});
