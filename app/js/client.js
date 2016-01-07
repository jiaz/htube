'use strict';

var EE = require('eventemitter3');
var remote = require('remote');
var app = remote.require('app');
var socketStream = require('socket.io-stream');
const dialog = remote.dialog;
const fs = require('fs');
const path = require('path');

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
    this.client = io('http://10.30.16.85.ip.hulu.com:3000', {
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
    readStream.pipe(fs.createWriteStream(receiveMap.get(params.guid)));
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
}

var htubeApp = angular.module('htubeApp', ['ngMaterial', 'ngRoute']);
var requestMap = new Map();
var receiveMap = new Map();

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
  $scope.userProfile = socket.session.userProfile;

  $scope.refreshUser = function refreshUser() {
    socket.listUsers((err, users) => {
      var newUsers = [];
      for (var u of users) {
        newUsers.push(JSON.parse(JSON.stringify(u)));
        newUsers.push(JSON.parse(JSON.stringify(u)));
        newUsers.push(JSON.parse(JSON.stringify(u)));
        newUsers.push(JSON.parse(JSON.stringify(u)));
        newUsers.push(JSON.parse(JSON.stringify(u)));
        newUsers.push(JSON.parse(JSON.stringify(u)));
        newUsers.push(JSON.parse(JSON.stringify(u)));
        newUsers.push(JSON.parse(JSON.stringify(u)));
        newUsers.push(JSON.parse(JSON.stringify(u)));
        newUsers.push(JSON.parse(JSON.stringify(u)));
        newUsers.push(JSON.parse(JSON.stringify(u)));
        newUsers.push(JSON.parse(JSON.stringify(u)));
        newUsers.push(JSON.parse(JSON.stringify(u)));
        newUsers.push(JSON.parse(JSON.stringify(u)));
        newUsers.push(JSON.parse(JSON.stringify(u)));
        newUsers.push(JSON.parse(JSON.stringify(u)));
      }
      console.log('list of users: ' + JSON.stringify(users));
      $scope.onUserUpdated(newUsers);
    });
  };

  $scope.onUserUpdated = function onUserUpdated(users) {
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
          requestMap.set(requestGuid, [user.userGuid, file]);
      }
    });
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
          ' (' + (data.fileSize / 1024 >> 0) + 'kb). Accept?'});
      if (choice) {
          let directories = dialog.showOpenDialog({properties: ['openDirectory']});
          if (directories) {
              socket.acceptRequest(data.sender, data.guid);
              receiveMap.set(data.guid, path.join(directories[0], data.file));
          }
      }
  });

  socket.on('start_send_file', (data) => {
      console.log('start sending file: ' + requestMap.get(data.guid)[1]);
      socket.sendFileStream(data, requestMap.get(data.guid)[1]);
  });

  socket.on('complete_send_file', (guid) => {
      requestMap.delete(guid);
      console.log(guid + ' send done! requestMap: ' + JSON.stringify(requestMap));
  });

  socket.on('complete_receive_file', (guid) => {
      receiveMap.delete(guid);
      console.log(guid + ' receive done! receiveMap: ' + JSON.stringify(receiveMap));
  });

  $scope.refreshUser();
}]);

htubeApp.factory('socket', function () {
  return new Socket();
});
